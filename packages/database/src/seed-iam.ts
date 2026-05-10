import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Seeds the IAM subsystem:
 * 1. Permission catalogue (150 functions x 3 tiers = 450 permissions)
 * 2. Scope types (PLATFORM, DISTRICT, SCHOOL, DEPARTMENT, CLASS, ACTIVITY)
 * 3. Default system roles (Platform Admin, School Admin, Teacher, Student, Parent, Staff)
 * 4. Role-permission mappings
 * 5. Scopes for the demo school
 * 6. Role assignments for the 5 test users
 */
async function seedIam() {
  console.log('');
  console.log('  IAM Seed');
  console.log('');

  var client = getPlatformClient();

  // ── 1. Reconcile permission catalogue against permissions.json ─────
  // Strategy: insert any missing codes; remove any DB rows whose code is no
  // longer in the JSON (also cleans up role_permissions and the effective
  // access cache, since role_permissions has an FK to permissions).
  var dataPath = join(__dirname, '..', 'data', 'permissions.json');
  var permData = JSON.parse(readFileSync(dataPath, 'utf-8'));
  var functions = permData.functions as Array<{ code: string; name: string; group: string }>;
  var tiers = permData.tiers as string[];

  var expectedCodes = new Set<string>();
  var expectedByCode: Record<string, { resource: string; action: string; description: string }> =
    {};
  for (var fi = 0; fi < functions.length; fi++) {
    var func = functions[fi]!;
    for (var ti = 0; ti < tiers.length; ti++) {
      var tier = tiers[ti]!;
      var code = func.code.toLowerCase() + ':' + tier;
      expectedCodes.add(code);
      expectedByCode[code] = {
        resource: func.code.toLowerCase(),
        action: tier,
        description: func.name + ' (' + tier + ')',
      };
    }
  }

  var existingPerms = await client.permission.findMany({ select: { id: true, code: true } });
  var existingByCode: Record<string, string> = {};
  for (var ep = 0; ep < existingPerms.length; ep++)
    existingByCode[existingPerms[ep]!.code] = existingPerms[ep]!.id;

  // Codes to add (in expected but not in DB)
  var toAdd: Array<{
    id: string;
    code: string;
    resource: string;
    action: string;
    description: string;
  }> = [];
  Array.from(expectedCodes).forEach(function (code) {
    if (!existingByCode[code]) {
      toAdd.push({ id: generateId(), code: code, ...expectedByCode[code]! });
    }
  });

  // Codes to remove (in DB but not in expected)
  var toRemove: string[] = [];
  for (var ec = 0; ec < existingPerms.length; ec++) {
    if (!expectedCodes.has(existingPerms[ec]!.code)) toRemove.push(existingPerms[ec]!.id);
  }

  if (toRemove.length > 0) {
    await client.rolePermission.deleteMany({ where: { permissionId: { in: toRemove } } });
    await client.permission.deleteMany({ where: { id: { in: toRemove } } });
    console.log(
      '  ' + toRemove.length + ' stale permission codes removed (and role_permissions cleared)',
    );
  }

  if (toAdd.length > 0) {
    await client.permission.createMany({ data: toAdd });
    console.log('  ' + toAdd.length + ' new permission codes added');
  }

  if (toRemove.length === 0 && toAdd.length === 0) {
    console.log('  Permissions catalogue already in sync (' + existingPerms.length + ' records)');
  }

  // ── 2. Seed scope types ────────────────────────────────────
  var scopeTypes = [
    { code: 'PLATFORM', label: 'Platform' },
    { code: 'DISTRICT', label: 'District' },
    { code: 'SCHOOL', label: 'School' },
    { code: 'DEPARTMENT', label: 'Department' },
    { code: 'CLASS', label: 'Class' },
    { code: 'ACTIVITY', label: 'Activity' },
    { code: 'WORKFLOW', label: 'Workflow' },
  ];

  var existingScopeTypes = await client.iamScopeType.count();
  if (existingScopeTypes > 0) {
    console.log('  Scope types already seeded');
  } else {
    for (var si = 0; si < scopeTypes.length; si++) {
      var st = scopeTypes[si]!;
      await client.iamScopeType.create({
        data: { id: generateId(), code: st.code, label: st.label },
      });
    }
    console.log('  ' + scopeTypes.length + ' scope types seeded');
  }

  // ── 3. Seed default roles ──────────────────────────────────
  // REVIEW-FINAL P1 — specialist role split. The original 6 roles
  // (Platform Admin / School Admin / Teacher / Student / Parent /
  // Staff) accumulated specialist permissions across cycles 4–32:
  // Staff effectively had Counsellor + Nurse + Librarian + AD +
  // EO + TC + FSM + FM + IT + DPO + Finance + Procurement +
  // Store + Activities + Reports authority all at once. This is
  // not appropriate for real-school operation under FERPA/HIPAA/
  // GDPR audits — least privilege applies.
  //
  // The 15 specialist roles below let a real school assign a
  // teacher to "Counsellor" without making them a generic Staff
  // member. The existing Staff role stays in place as a baseline
  // ("general support" — admin assistants, office staff who don't
  // hold a specialist function); narrowing its over-grants is a
  // separate Phase-2 cleanup once production specialist roles are
  // populated. Demo accounts vp@ and counsellor@ are now layered
  // — they hold their specialist role IN ADDITION to Staff so the
  // existing CAT scripts continue to pass.
  //
  // Adding a new role to this list is idempotent — the per-role
  // findFirst/create loop below picks up missing names without
  // touching existing rows.
  var roleNames = [
    'Platform Admin',
    'School Admin',
    'Teacher',
    'Student',
    'Parent',
    'Staff',
    // Specialist roles introduced by REVIEW-FINAL P1.
    'Vice Principal',
    'Counsellor',
    'Nurse',
    'Librarian',
    'Athletic Director',
    'Activities Coordinator',
    'Enrolment Officer',
    'Transportation Coordinator',
    'Food Service Manager',
    'Facilities Manager',
    'IT Administrator',
    'Finance Officer',
    'Procurement Officer',
    'Store Manager',
    'DPO',
  ];
  var addedRoles = 0;
  for (var ri = 0; ri < roleNames.length; ri++) {
    var nm = roleNames[ri]!;
    var existing = await client.role.findFirst({ where: { name: nm } });
    if (existing) continue;
    await client.role.create({
      data: {
        id: generateId(),
        name: nm,
        description: nm + ' system role',
        isSystem: true,
      },
    });
    addedRoles++;
  }
  if (addedRoles === 0) {
    console.log('  Roles already seeded (' + roleNames.length + ' total)');
  } else {
    console.log(
      '  ' +
        addedRoles +
        ' new role(s) added (' +
        roleNames.length +
        ' total: 6 baseline + 15 specialist)',
    );
  }

  // ── 4. Assign ALL permissions to Platform Admin (reconciling) ──────
  // Add any newly-added codes; existing assignments stay. Removed codes
  // were already cleared in step 1's reconciliation.
  var adminRole = await client.role.findFirst({ where: { name: 'Platform Admin' } });
  var allPerms = await client.permission.findMany({ select: { id: true } });
  var adminExisting = await client.rolePermission.findMany({
    where: { roleId: adminRole!.id },
    select: { permissionId: true },
  });
  var adminAssigned: Record<string, boolean> = {};
  for (var aei = 0; aei < adminExisting.length; aei++)
    adminAssigned[adminExisting[aei]!.permissionId] = true;
  var adminToAdd: Array<{ id: string; roleId: string; permissionId: string }> = [];
  for (var ap = 0; ap < allPerms.length; ap++) {
    if (!adminAssigned[allPerms[ap]!.id]) {
      adminToAdd.push({ id: generateId(), roleId: adminRole!.id, permissionId: allPerms[ap]!.id });
    }
  }
  if (adminToAdd.length > 0) {
    await client.rolePermission.createMany({ data: adminToAdd });
    console.log(
      '  Platform Admin: ' +
        adminToAdd.length +
        ' permissions newly assigned (' +
        (adminExisting.length + adminToAdd.length) +
        ' total)',
    );
  } else {
    console.log('  Platform Admin: ' + adminExisting.length + ' permissions already assigned');
  }

  // ── 4b. Assign baseline permissions to non-admin roles ─────
  // Each role gets a curated subset for Cycle 1 (SIS + Attendance).
  // Idempotent: only inserts pairs that don't already exist.
  var rolePermsSpec: Array<{
    roleName: string;
    everyFunction?: string[];
    perms?: Record<string, string[]>;
  }> = [
    { roleName: 'School Admin', everyFunction: ['read', 'write', 'admin'] },
    {
      roleName: 'Teacher',
      perms: {
        'ATT-001': ['read', 'write'],
        'ATT-002': ['write'],
        'ATT-003': ['write'],
        'ATT-004': ['read'],
        'ATT-005': ['read', 'write'],
        'STU-001': ['read'],
        'TCH-001': ['read', 'write'],
        'TCH-002': ['read', 'write'],
        'TCH-003': ['read', 'write'],
        'TCH-004': ['read', 'write'],
        'TCH-006': ['read', 'write'],
        // Cycle 23 — Curriculum Management. Teachers (acting as
        // Department Head / Curriculum Coordinator) create maps,
        // units, alignments, lesson links, and resources. Row scope
        // at the Step 5 service layer binds non-admin teachers to
        // maps for subjects they teach.
        'TCH-008': ['read', 'write'],
        // Cycle 24 — Achievements + Student Portfolio. Teachers
        // award achievements (ACH-001:write — ACADEMIC, LEADERSHIP,
        // COMMUNITY, etc.) to students in their classes. Portfolio
        // read for browsing student portfolios at TEACHER+
        // visibility (annotation surface deferred — write tier
        // gates the future teacher-comment feature only).
        'ACH-001': ['read', 'write'],
        'ACH-002': ['read', 'write'],
        // Cycle 25 — Publications (Wave 5 closeout). Teachers create
        // series + editions, author content sections, manage section
        // contributors. Distribution (PUB-003) is admin-only.
        'PUB-001': ['read', 'write'],
        'PUB-002': ['read', 'write'],
        // Cycle 27 — Procurement. Teachers submit requisitions
        // for classroom supplies / technology / consumables.
        // Row scope at the Step 5 RequisitionService binds
        // teachers to own requisitions; PO management,
        // receiving, distribution, and returns are PRC-002 /
        // PRC-003 admin / staff.
        'PRC-001': ['read', 'write'],
        // Cycle 28 — School Store. Teachers browse the catalogue
        // (STR-001:read) so they can recommend products, but they
        // do not place orders or manage products at the catalogue
        // tier (write is admin-only via everyFunction).
        'STR-001': ['read'],
        // Cycle 29 — Analytics. Teachers see class-level dashboards
        // (attendance + class performance) for their own classes via
        // the row-scope at AnalyticsService. They do NOT receive RPT-002
        // (school dashboards + at-risk lists are admin/counsellor-only)
        // or RPT-003/004 (district dashboards + report engine are admin
        // only). Class-scoped row filter at the API layer is the actual
        // access boundary.
        'RPT-001': ['read'],
        'COM-001': ['read', 'write'],
        'COM-002': ['read', 'write'],
        // Cycle 14 — emergency alert read so the persistent banner
        // renders for teachers when the school issues an EMERGENCY
        // alert. Acknowledgement is row-scoped to own deliveries at
        // the EmergencyAlertService layer.
        'COM-003': ['read'],
        // Cycle 15 — Meetings & Conferences. Teachers create meetings,
        // manage agendas, set PTC availability, and write notes.
        'MTG-001': ['read', 'write'],
        'MTG-002': ['read', 'write'],
        'SCH-001': ['read'],
        'SCH-003': ['read'],
        // Cycle 5 — coverage read so a teacher sees their own coverage,
        // room booking read+write so they can request and manage rooms.
        'SCH-004': ['read'],
        'SCH-005': ['read', 'write'],
        'BEH-001': ['read', 'write'],
        // Cycle 9 — teachers read BIPs for students in their classes and
        // submit teacher feedback on strategy effectiveness. The Step 5
        // FeedbackService PATCH endpoint is gated on beh-002:read plus a
        // row-scope check (caller's employeeId === row's teacher_id) so
        // teachers do not need beh-002:write to submit their assigned
        // feedback. Counsellor-side BIP create / edit ships under the
        // Staff role's beh-002:read+write grant below.
        'BEH-002': ['read'],
        // Cycle 11 — Counselling & Student Support. Teacher reads
        // caseload assignment for class students (counsellor name +
        // concern, with notes stripped server-side via the per-row
        // manager check on CaseloadService — teachers see who is
        // counselling the student but NOT the counsellor's notes).
        // Submits and tracks referrals (COU-002 read+write — row scope
        // at the Step 5 ReferralService limits non-counsellor reads to
        // own submitted referrals), reads accommodation info via
        // COU-005 for the IEP/504 surface already covered by ADR-030
        // read model + the accommodations panel, and can file a
        // mandatory report (COU-006 write — every employee is a
        // mandated reporter). Teachers do NOT receive
        // student_counseling_record:read — session notes are
        // FERPA-protected counselling content gated to Staff and
        // Admin only.
        'COU-001': ['read'],
        'COU-002': ['read', 'write'],
        'COU-005': ['read'],
        'COU-006': ['write'],
        // Cycle 11.1 — Wellbeing Check-Ins. Teachers receive COU-004:read
        // for the aggregated trends panel only (e.g. "1 of 1 completed
        // this week"). The Step 5 service strips individual student
        // responses and alert details for non-counsellor readers; the
        // teacher trend rollup is the only data shape teachers ever see.
        'COU-004': ['read'],
        'HR-001': ['read'],
        'HR-003': ['read', 'write'],
        'HR-004': ['read'],
        // P2-4c — HR-005 Appraisals (own appraisal read), HR-012
        // Expense Claims (own claim submit). Both row-scoped at the
        // service layer to actor.employeeId. Lesson observations
        // are intentionally NOT granted (lesson_observation:write is
        // admin-only via everyFunction; teachers see their own
        // observation reports through the appraisal detail surface
        // because hr_lesson_observations.appraisal_id ties the row
        // back to an HR-005-readable appraisal).
        'HR-005': ['read'],
        'HR-012': ['read', 'write'],
        // Profile & Household mini-cycle — every persona self-services
        // their own profile via /profile/me. Row scope at the service
        // layer keeps non-admins bound to their own iam_person row.
        'USR-001': ['read', 'write'],
        // Cycle 7 — task management. Every persona has a to-do list
        // surface. Row scope at the service layer keeps callers bound
        // to their own owner_id. School Admin and Platform Admin get
        // the admin tier through the everyFunction grant.
        'OPS-001': ['read', 'write'],
        // Cycle 8 — service tickets. Teachers and Staff can submit
        // and track tickets. The service layer row-scopes
        // requesters to their own tickets and assignees to tickets
        // they own. School Admin and Platform Admin get the admin
        // tier (queue + assignment + category + vendor management)
        // via the everyFunction grant. FAC-001:admin is reached the
        // same way; we do not extend FAC-001 read/write to non-admin
        // staff this cycle — IT-001 is the umbrella code the Step 4
        // TicketService gates on for all ticket categories.
        'IT-001': ['read', 'write'],
        // P2C1 — Visitor Management (M90). Teachers see the on-site
        // visitor list and the today's pre-registrations panel via
        // SAF-002:read. They do NOT receive write (kiosk processing,
        // pre-registration creation, banned-persons management) which
        // belongs to Staff (reception / safeguarding officer) and
        // School Admin via everyFunction.
        'SAF-002': ['read'],
        // P2C2 — Incident & Emergency (M91). Teachers see emergency
        // procedures + drill schedule + active-incident dashboard
        // via SAF-001:read. They do NOT receive write (declaration,
        // accountability updates, reunification) which belongs to
        // Staff (school admin assistant, safeguarding officer) and
        // School Admin via everyFunction. Teachers report
        // non-discipline incidents via SAF-003:write (their own
        // playground-injury / property-damage / medical-episode
        // observations) and read their own reports back via
        // SAF-003:read. Drill management (SAF-004) is admin-only
        // through everyFunction.
        'SAF-001': ['read'],
        'SAF-003': ['read', 'write'],
        // the future Step 5 HealthRecordService can return the
        // accommodation-level health summary used in the classroom (no
        // PII; the service strips management_plan, emergency_medical_notes,
        // and condition severity for non-managers). Teachers do NOT
        // receive HLT-002 / 003 / 004 / 005 — medication, nurse visits,
        // screenings, and dietary are nurse-only surfaces. The ADR-030
        // sis_student_active_accommodations table is the canonical
        // teacher read path for IEP / 504 accommodations.
        'HLT-001': ['read'],
        // Cycle 12 — Library. Teachers browse the catalogue (LIB-001:read),
        // see their own staff checkouts + holds + fines (LIB-002:read),
        // and create or curate reading lists for their classes
        // (LIB-003:write — staff can author lists alongside the
        // librarian). Teachers do NOT receive LIB-001:write — only the
        // librarian (Staff role) adds items + copies. Teachers do NOT
        // receive LIB-002:write — only the librarian processes the
        // checkout / return / renew lifecycle.
        'LIB-001': ['read'],
        'LIB-002': ['read'],
        'LIB-003': ['write'],
        // Cycle 13 — Athletics. Teachers view programmes + rosters
        // (ATH-001:read), the public game schedule + results (ATH-002:read),
        // and athlete injury status for their own students (ATH-004:read —
        // covers head coaches who teach during the day). Write paths
        // for programmes, results, coaching, injuries, clearances are
        // AD/admin-only (Staff role).
        'ATH-001': ['read'],
        'ATH-002': ['read'],
        'ATH-004': ['read'],
        // Cycle 17 — Clubs & Student Life. Teachers manage activities
        // they advise (CLB-001:read+write) and plan field trips
        // (CLB-003:read+write). Election management (CLB-002:write) and
        // service hour approval (CLB-004:write) ship under the Staff
        // role's broader CLB grants below.
        'CLB-001': ['read', 'write'],
        'CLB-003': ['read', 'write'],
        // Cycle 18 — Groups & Communities. Teachers browse + create
        // groups + post announcements + create events on groups they
        // own/admin. Cross-role social fabric.
        'GRP-001': ['read', 'write'],
        // Cycle 19 — Transportation. Teachers see route + assignment
        // info but do not manage routes or fleet. TRN-001:read covers
        // the read-only Transportation app tile.
        'TRN-001': ['read'],
        // Cycle 20 — Food Service. Teachers view menus only.
        'FDS-001': ['read'],
        // Cycle 21 — Facilities. Teachers can view buildings + book
        // spaces (FAC-001:read+write). Work order management, PM,
        // inspections, zones, and supply remain Staff-only.
        'FAC-001': ['read', 'write'],
        // Cycle 22 — IT Infrastructure. Teachers see their own
        // assigned devices (IT-002:read row-scopes to assigned_to_id
        // = me at the service layer) and can file damage reports
        // (IT-002:write). The Cycle 22 plan also gives staff visibility
        // into installed software via IT-004:read (used by the future
        // self-service licence picker). Credential vault (IT-005),
        // MDM (IT-006), and Device Selection management (IT-003)
        // remain IT-admin only — teachers can SELECT a device during
        // onboarding via IT-003:write (parent-active path) but the
        // approve / provision pipeline is Staff/admin.
        'IT-002': ['read', 'write'],
        'IT-003': ['read', 'write'],
        'IT-004': ['read'],
      },
    },
    {
      roleName: 'Parent',
      perms: {
        'ATT-001': ['read'],
        'ATT-004': ['read', 'write'],
        'STU-001': ['read'],
        'TCH-002': ['read'],
        'TCH-003': ['read'],
        'TCH-004': ['read'],
        // Cycle 23 — Curriculum Management. Parents browse
        // PUBLISHED curriculum maps + non-teacher-only resources.
        'TCH-008': ['read'],
        // Cycle 24 — Achievements + Student Portfolio. Parents
        // view their child's achievements (ACH-001:read row-scoped
        // via sis_student_guardians) and the child's portfolio
        // when visibility is PARENT or PUBLIC (read-only at the
        // service layer — parents cannot edit a student's curated
        // portfolio).
        'ACH-001': ['read'],
        'ACH-002': ['read'],
        // Cycle 25 — Publications. Parents read published series +
        // editions and manage subscriptions on the my-subscriptions
        // surface.
        'PUB-001': ['read'],
        // Cycle 28 — School Store. Parents browse the STUDENT store
        // catalogue, see their child's order history, AND approve /
        // decline pending student orders via the PARENT APPROVAL
        // GATE (STR-002:write covers approve + decline + place
        // orders on behalf of own children).
        'STR-001': ['read'],
        'STR-002': ['read', 'write'],
        'COM-001': ['read', 'write'],
        'COM-002': ['read'],
        // Cycle 14 — emergency alert read so the dismiss-proof
        // banner reaches parents.
        'COM-003': ['read'],
        // Cycle 15 — Meetings. Parents view meeting schedule and
        // book PTC slots. Action items + parent-visible notes are
        // accessed via row scope on assignee_id and the
        // is_parent_visible + is_approved gate respectively.
        'MTG-001': ['read'],
        'MTG-002': ['read'],
        'SCH-003': ['read'],
        // Cycle 6 — Enrollment write so a parent can submit + track an
        // application (row-scoped to their own apps in ApplicationService).
        // Family Billing read for the parent billing dashboard, invoice list,
        // and ledger view; FIN-001:write so the parent can hit Pay Now —
        // the row-scope check at the service layer (account_holder_id =
        // actor.personId) keeps parents bound to their own family account.
        'STU-003': ['read', 'write'],
        // P2-5 — withdrawal + re-enrolment self-service for parents.
        // WithdrawalService gates initiate-by-family on (actor as guardian
        // of the student) via sis_student_guardians. ReenrolmentService
        // is parent-write only for the family confirmation; admin
        // processes via STU-004 admin tier from everyFunction.
        'STU-004': ['read', 'write'],
        'FIN-001': ['read', 'write'],
        // Profile & Household mini-cycle — own profile self-service +
        // shared-household editing (HouseholdsService gates on member
        // role HEAD_OF_HOUSEHOLD or SPOUSE).
        'USR-001': ['read', 'write'],
        // Cycle 7 — task management. Every persona has a to-do list
        // surface. Row scope at the service layer keeps callers bound
        // to their own owner_id. School Admin and Platform Admin get
        // the admin tier through the everyFunction grant.
        'OPS-001': ['read', 'write'],
        // Cycle 9 — parents read discipline incidents for their own
        // children only. The IncidentService row-scope joins through
        // sis_student_guardians keyed on actor.personId; admin_notes
        // is stripped for non-managers per the Step 4 visibility
        // contract. Parents do NOT receive write — only staff can
        // report incidents.
        'BEH-001': ['read'],
        // Cycle 9 Step 9 — parents read a summary of their own child's
        // BIPs (plan_type, status, review_date, goals + progress). The
        // BehaviorPlanService.buildVisibility GUARDIAN branch joins
        // through sis_student_guardians keyed on actor.personId; the
        // service additionally strips the feedback[] array for parents
        // (private teacher observations stay staff-side per the Step 9
        // visibility contract). Parents do NOT receive write — only
        // counsellors and admins author plans.
        'BEH-002': ['read'],
        // Cycle 11 — parents see only that their child has an active
        // caseload and the counsellor's name. The Step 5 CaseloadService
        // GUARDIAN branch returns a stripped DTO for parents — counsellor
        // name and primary concern only, no notes. Parents do NOT
        // receive any other COU code: no referrals, no MTSS, no session
        // notes, no coordinated care, no mandatory reports.
        'COU-001': ['read'],
        // Cycle 10 — parents read their own child's health summary
        // (allergies, conditions overview, immunisation status,
        // medication schedule, recent nurse visits). Row scope at the
        // future Step 5 HealthRecordService GUARDIAN branch joins
        // through sis_student_guardians keyed on actor.personId. The
        // service strips management_plan from conditions, full
        // emergency_medical_notes, and IEP details before returning
        // the parent payload. Parents do NOT receive HLT-002 / 003 /
        // 004 / 005 — medication administration logs, nurse-visit
        // detail, screening results, and dietary admin are nurse
        // surfaces (a parent can see meds via the parent summary on
        // HLT-001:read but can't audit the administration log).
        'HLT-001': ['read'],
        // Cycle 12 — Library. Parents browse the catalogue
        // (LIB-001:read) so they can see what their child is reading +
        // search for titles to recommend. Parents do NOT receive
        // LIB-002:read in this cycle — child checkout/hold/fine
        // visibility is a future polish (the parent UI on
        // /children/[id]/library will surface the row-scoped child
        // checkout summary once that surface ships).
        'LIB-001': ['read'],
        // Cycle 13 — Athletics. Parents view programmes + rosters
        // (ATH-001:read) so they can see which sport their child plays,
        // and the public game schedule + results (ATH-002:read) for
        // upcoming games. Parents do NOT receive ATH-004:read this
        // cycle — injury status is restricted to staff (parents are
        // notified separately via the school health record path on
        // HLT-001:read once the injury links into hlth_).
        'ATH-001': ['read'],
        'ATH-002': ['read'],
        // Cycle 17 — Clubs & Student Life. Parents view their child's
        // activities (CLB-001:read for the per-child clubs panel) and
        // their child's field trips + consent forms (CLB-003:read for
        // the parent consent portal at /children/:id/field-trips).
        // Parents do NOT receive write — only Staff plans trips and
        // manages activities. The actual consent-sign endpoint is
        // gated by clb-003:read because the service-layer row-scope
        // (guardian_person_id == actor.personId) is the access boundary.
        'CLB-001': ['read'],
        'CLB-003': ['read'],
        // Cycle 18 — Groups & Communities. Parents browse + join
        // groups they're invited to. Service-layer row scope binds
        // membership-derived reads to actor.personId.
        'GRP-001': ['read', 'write'],
        // Cycle 19 — Transportation. Parents view their child's route +
        // bus pass + ridership history (TRN-001:read), and submit
        // route-change requests with the parent-portal flow
        // (TRN-005:read+write — parent-active feature). The Step 5
        // RouteChangeRequestService row-scopes parent reads to own
        // children via sis_student_guardians keyed on actor.personId.
        'TRN-001': ['read'],
        'TRN-005': ['read', 'write'],
        // Cycle 20 — Food Service. Parents view today's menu (FDS-001:read)
        // + their child's dietary profile and NSLP eligibility status
        // (FDS-003:read). The DietaryProfileService row-scopes parent
        // reads to own children via sis_student_guardians keyed on
        // actor.personId. Parents submit dietary update requests via the
        // same FDS-003:read gate; the row-scope check at the service
        // layer is the actual access boundary, mirroring the Cycle 19
        // route-change request and Cycle 1 attendance self-service
        // patterns. Parents do NOT receive FDS-002 (POS) or FDS-004
        // (food safety / USDA) — those are FSM-only.
        'FDS-001': ['read'],
        'FDS-003': ['read'],
        // Cycle 30 — Data Protection. Parents submit Subject Access
        // Requests (DPO-004:read+write) for their children via the
        // self-service portal. Row-scope at SARService binds the
        // request's data_subject_id to a child of the calling parent
        // via sis_student_guardians. Age-18 transfer flips
        // platform_students.data_subject_is_self=true and SARService
        // refuses parent-submitted requests after the flip.
        'DPO-004': ['read', 'write'],
      },
    },
    {
      roleName: 'Student',
      perms: {
        'ATT-001': ['read'],
        'STU-001': ['read'],
        'TCH-001': ['read'],
        'TCH-002': ['read', 'write'],
        'TCH-003': ['read'],
        'TCH-004': ['read'],
        'TCH-006': ['read', 'write'],
        'TCH-007': ['read', 'write'],
        // Cycle 23 — students view PUBLISHED curriculum maps for
        // their classes + non-teacher-only resources.
        'TCH-008': ['read'],
        // Cycle 24 — Achievements + Student Portfolio. THE FOURTH
        // student-input surface in CampusOS after wellbeing check-
        // ins (Cycle 11.1), library reading logs / reviews (Cycle
        // 12), and clubs service hours (Cycle 17) — and the FIRST
        // truly student-owned surface. ACH-001:read for own
        // achievement gallery. ACH-002:read+write for portfolio
        // CRUD: curate items, set visibility (PRIVATE / TEACHER /
        // PARENT / PUBLIC), and generate share links. Row scope at
        // the Step 4 service layer binds students to their own
        // portfolio + own achievements only.
        'ACH-001': ['read'],
        'ACH-002': ['read', 'write'],
        // Cycle 25 — Publications. Students read published editions
        // and contribute to sections (PUB-002:write); their sections
        // require editor approval per ADR-035.
        'PUB-001': ['read'],
        'PUB-002': ['read', 'write'],
        // Cycle 28 — School Store. Students browse the STUDENT
        // catalogue (STR-001:read) AND place orders (STR-002:write —
        // every student order auto-creates a PENDING str_order_approvals
        // row inside the OrderService.create tx; the parent must
        // approve before payment fires). Students see their own
        // orders via STR-002:read (row-scoped at the Step 6 service
        // to own customer_person_id only).
        'STR-001': ['read'],
        'STR-002': ['read', 'write'],
        'COM-001': ['read', 'write'],
        'COM-002': ['read'],
        // Cycle 14 — students see emergency alerts on their devices.
        'COM-003': ['read'],
        // Cycle 15 — students view meetings they are participants in.
        'MTG-001': ['read'],
        'SCH-003': ['read'],
        // Profile & Household mini-cycle — students self-service their
        // own profile + Demographics tab. Household is read-only for
        // non-HEAD/SPOUSE members per HouseholdsService.canEdit.
        'USR-001': ['read', 'write'],
        // Cycle 7 — task management. Every persona has a to-do list
        // surface. Row scope at the service layer keeps callers bound
        // to their own owner_id. School Admin and Platform Admin get
        // the admin tier through the everyFunction grant.
        'OPS-001': ['read', 'write'],
        // Cycle 11.1 — Wellbeing Check-Ins. The first student-input
        // surface in CampusOS. Students receive COU-004:read so the
        // Step 7 student UI at /wellbeing renders own pending check-ins
        // + own response history. Row scope at the Step 5 service
        // layer binds students to their own check-ins (sis_students.id
        // resolved via actor.personId → platform_students → sis_students)
        // and to own responses only — students never see other
        // students' check-ins, never see alert status, never see the
        // flagged_for_follow_up flag (the counsellor initiates any
        // follow-up conversation naturally without surfacing the
        // technical flag to the student).
        'COU-004': ['read'],
        // Cycle 12 — Library. Students browse the catalogue
        // (LIB-001:read), see their own checkouts + holds + fines
        // (LIB-002:read; the Step 6 CheckoutService row-scopes patron
        // reads to the calling iam_person.id), and **log reading
        // entries + write book reviews** (LIB-003:read+write — THE
        // SECOND STUDENT-INPUT PERMISSION in CampusOS after Cycle
        // 11.1 wellbeing's COU-004:read). Row scope at the Step 7
        // ReadingLogService + ReviewService binds students to their
        // own student_id so they cannot log on behalf of other
        // students or post reviews to other students' accounts.
        'LIB-001': ['read'],
        'LIB-002': ['read'],
        'LIB-003': ['read', 'write'],
        // Cycle 13 — Athletics. Students view programmes + rosters
        // (ATH-001:read), see their game schedule + results
        // (ATH-002:read), and view their own injury status
        // (ATH-004:read — row-scoped at the Step 7 InjuryService to
        // own student_id only, so a student cannot see other
        // students' injuries). Students do NOT receive any write
        // permission — roster eligibility, results, stats, injuries,
        // and clearances are all AD-managed.
        'ATH-001': ['read'],
        'ATH-002': ['read'],
        'ATH-004': ['read'],
        // Cycle 17 — Clubs & Student Life. Students browse and join
        // clubs (CLB-001:read for the catalogue + the self-registration
        // path on /clubs/activities/:id/join). Students view active
        // elections + cast their anonymous ballot (CLB-002:read — the
        // VoteService.cast endpoint is gated on clb-002:read since the
        // anonymity keystone happens at the schema level, not the
        // permission layer). CLB-004:read+write is the third
        // student-input write permission in CampusOS after wellbeing
        // check-ins (Cycle 11.1) and library reading logs / reviews
        // (Cycle 12) — students log their own service hours and view
        // their own progress.
        'CLB-001': ['read'],
        'CLB-002': ['read'],
        'CLB-004': ['read', 'write'],
        // Cycle 18 — Groups & Communities. Students browse + join
        // groups (open or approval-required). Service-layer row
        // scope at the Step 5 GroupService binds member-derived
        // reads to actor.personId.
        'GRP-001': ['read', 'write'],
        // Cycle 19 — Transportation. Students view their own bus
        // pass + route info via TRN-001:read. The Step 7
        // BusPassService row-scopes my-pass reads to the calling
        // student's iam_person.id.
        'TRN-001': ['read'],
        // Cycle 20 — Food Service. Students view today's menu via
        // FDS-001:read so the per-item allergen pills surface in the
        // student dashboard.
        'FDS-001': ['read'],
        // Cycle 22 — IT Infrastructure. Students see their own
        // assigned devices (IT-002:read row-scoped at the service
        // layer) and select a device during onboarding via
        // IT-003:write (parent-active path).
        'IT-002': ['read'],
        'IT-003': ['read', 'write'],
        // Cycle 30 — Data Protection. Students submit Subject Access
        // Requests for their own data (DPO-004:read+write). Pre-age-18
        // a student-submitted request is permitted but row-scoped to
        // own data_subject_id; post-age-18 (platform_students.
        // data_subject_is_self=true) the student is the only party
        // permitted to submit. Mirrors the Cycle 11.1 student-input
        // surface convention.
        'DPO-004': ['read', 'write'],
      },
    },
    {
      roleName: 'Staff',
      perms: {
        'STU-001': ['read'],
        'ATT-001': ['read'],
        'COM-001': ['read', 'write'],
        'COM-002': ['read', 'write'],
        // Cycle 14 — Staff covers the admin operator. read for
        // banner + write for issuing emergency alerts via
        // EmergencyAlertService.
        'COM-003': ['read', 'write'],
        // Cycle 15 — Staff covers VP / counsellor and creates
        // staff + IEP review meetings. MTG-002:read for visibility
        // into PTC schedules.
        'MTG-001': ['read', 'write'],
        'MTG-002': ['read'],
        // Cycle 16 — Enrolment Officer (EO) reviews applications,
        // advances stages, scores criteria, issues offers, and
        // manages onboarding. Held by Staff (covers EO) so the
        // pipeline endpoints clear the @RequirePermission gate.
        'STU-003': ['read', 'write'],
        // P2-5 — withdrawal + transfer surface. Staff covers EO +
        // per-department staff (librarian, IT, facilities, finance,
        // registrar, transport, food service) closing exit tasks
        // for their department. Service-layer per-department
        // routing in ExitTaskService keeps a department staff
        // member from completing another department's tasks.
        'STU-004': ['read', 'write'],
        // REVIEW-CYCLE14 MAJOR 6 — COM-004 not granted to Staff
        // because ModerationService.assertAdmin() requires
        // actor.isSchoolAdmin specifically (a stricter contract
        // than the permission gate on the controller). Moderation
        // policy + queue + log are admin-only. Re-introducing
        // COM-004 to Staff would require relaxing the service-side
        // assertAdmin to accept tenant-scoped com-004:write — a
        // locked product decision deferred to the AD/role-split
        // pre-pilot work.
        'SCH-001': ['read'],
        'SCH-003': ['read'],
        // Cycle 5 — coverage read so VPs and counsellors who fill in as
        // substitutes can see their assignments, room booking read+write
        // so non-teaching staff can book the hall, library, etc.
        'SCH-004': ['read'],
        'SCH-005': ['read', 'write'],
        // Cycle 4 HR — staff who aren't teachers (counsellor, vp,
        // admin assistant) still read the directory + manage own leave +
        // view own certs.
        'HR-001': ['read'],
        // REVIEW-P2-4b BLOCKING #1 — HR-002 NOT granted to the broad
        // Staff role. The Recruitment admin pipeline (applications,
        // offers, panels, interviews, evaluations, salary offers) is
        // sensitive PII (candidate emails, resumes, evaluator notes,
        // salary detail) and must NOT be readable by every Staff
        // user. The pipeline is now gated on the new HR-011 code
        // (Recruitment Administration), held only by School Admin /
        // Platform Admin via everyFunction. HR-002:read remains the
        // candidate-facing surface (own application + own offer
        // respond, narrowed at the service layer by personId); we
        // do not grant HR-002 to Staff so generic VPs / counsellors
        // / admin assistants cannot enumerate candidates. The public
        // job-board + apply paths bypass the IAM gate via @Public().
        // Recruitment Administrator role split is the canonical
        // pre-pilot follow-up (joins items 9 / 11 / 13 / 14 / 16 /
        // 22 / 25 / 26 / 30 / 32 / 33 in the broader role-split
        // chain).
        'HR-003': ['read', 'write'],
        // P2-4c — Staff covers the Principal / dept-head stand-in
        // for the Cycle 4 demo until a dedicated role split lands
        // pre-pilot. HR-004:write lets Staff create programmes,
        // schedule events, and record completions; HR-005:read+write
        // covers appraisal cycle creation + per-employee appraisal
        // management. lesson_observation:write is intentionally NOT
        // granted to Staff — it stays admin-only via everyFunction
        // because classroom observation records are sensitive
        // (mirrors the P2C3 student_counseling_record:read pattern).
        // HR-012:read+write covers self-service expense claim
        // submission AND admin approval routing — service-layer
        // narrowing binds non-admin readers to actor.employeeId for
        // the submit path, while admin approval is gated by the
        // service-layer assertAdmin (everyFunction-derived).
        'HR-004': ['read', 'write'],
        'HR-005': ['read', 'write'],
        'HR-012': ['read', 'write'],
        // REVIEW-P2-4a BLOCKING #3 — HR-010 Payroll Management. The
        // P2-4a payroll module added new admin pay-period / pay-grade
        // / aggregate-totals reads that must NOT be exposed via the
        // broad HR-003:read held by Teacher / Staff for self-service
        // payslips + leave. Staff (covering the school payroll
        // operator) gets HR-010:read+write; School Admin and Platform
        // Admin pick up admin tier through everyFunction. Teacher
        // intentionally NOT granted HR-010 — the payslip self-service
        // surface stays on hr-003:read with service-layer self-binding.
        'HR-010': ['read', 'write'],
        // Cycle 24 — Staff covers VP / counsellor / admin assistant who
        // award achievements (LEADERSHIP, COMMUNITY) and review portfolios
        // for at-risk students. Same scope as Teacher.
        'ACH-001': ['read', 'write'],
        'ACH-002': ['read', 'write'],
        // Cycle 25 — Publications. Staff covers VP / counsellor / admin
        // assistant who manage series + editions + content authoring +
        // distribution.
        'PUB-001': ['read', 'write'],
        'PUB-002': ['read', 'write'],
        'PUB-003': ['read', 'write'],
        // Profile & Household mini-cycle — every persona self-services
        // their own profile (covers VP, counsellor, admin assistant).
        'USR-001': ['read', 'write'],
        // Cycle 7 — task management. Every persona has a to-do list
        // surface. Row scope at the service layer keeps callers bound
        // to their own owner_id. School Admin and Platform Admin get
        // the admin tier through the everyFunction grant.
        'OPS-001': ['read', 'write'],
        // Cycle 8 — service tickets. VPs, counsellors, and admin
        // assistants submit and track tickets the same way teachers
        // do. Same gating model as Teacher above — IT-001 is the
        // umbrella code, FAC-001 admin tier reached via everyFunction
        // for school admins.
        'IT-001': ['read', 'write'],
        // P2C1 — Visitor Management (M90). Staff covers the
        // reception desk and the safeguarding officer stand-in.
        // SAF-002:read+write covers the kiosk processing surface,
        // visitor type catalogue, pre-registration creation,
        // recurring-visitor schedules, and emergency muster
        // creation + per-entry accountability marking. The
        // safeguarding_ban gate (banned-persons plaintext name +
        // court-order S3 key) is admin-only — Staff cannot see
        // banned-person details, only the BLOCKED kiosk outcome
        // event via the silent vis.banned_person.detected emit.
        'SAF-002': ['read', 'write'],
        // P2C2 — Incident & Emergency (M91). Staff (covering the
        // school admin assistant, the safeguarding officer, and the
        // VP / counsellor in that role) holds the full operational
        // surface during an incident. SAF-001:read+write covers
        // declaring an emergency, posting timeline events,
        // updating accountability, and processing reunification at
        // the reception station. SAF-003:read+write covers logging
        // and reviewing non-discipline incidents. SAF-004:read+write
        // covers scheduling drills and recording results. The
        // admin tier on each of the three codes (catalogue + procedure
        // CRUD, drill overdue management, incident-type configuration)
        // is reached by School Admin and Platform Admin via the
        // everyFunction grant.
        'SAF-001': ['read', 'write'],
        'SAF-003': ['read', 'write'],
        'SAF-004': ['read', 'write'],
        // Cycle 9 — behaviour & discipline. VPs, counsellors, and
        // admin assistants log incidents the same way teachers do
        // (BEH-001 read+write). Counsellors are the canonical author
        // of BIPs so Staff also gets BEH-002 read+write to create
        // and edit behaviour intervention plans, set goals, and
        // request teacher feedback. School Admin and Platform Admin
        // pick up the admin tier (catalogue management, hard delete)
        // via the everyFunction grant.
        'BEH-001': ['read', 'write'],
        'BEH-002': ['read', 'write'],
        // Cycle 10 — health module is nurse-and-counsellor work.
        // Staff (covering nurse, counsellor, VP, admin assistant)
        // receives full read+write across all five HLT codes:
        // HLT-001 (records + conditions + immunisations),
        // HLT-002 (medications + administration log),
        // HLT-003 (nurse visits + live roster),
        // HLT-004 (screenings + follow-up queue),
        // HLT-005 (dietary profiles + POS allergen alerts).
        // School Admin and Platform Admin pick up the admin tier
        // (HIPAA access log audit view, EXPORT, hard-delete) via
        // the everyFunction grant. The Step 5 HealthAccessLogService
        // writes a row to hlth_health_access_log on every read
        // regardless of caller role per the ADR-010 immutable-audit
        // contract.
        'HLT-001': ['read', 'write'],
        'HLT-002': ['read', 'write'],
        'HLT-003': ['read', 'write'],
        'HLT-004': ['read', 'write'],
        'HLT-005': ['read', 'write'],
        // P2C3 — Health Advanced. HLT-006 Telehealth covers the
        // provider directory + session scheduling + encrypted
        // document exchange. Staff (nurse stand-in) read+write;
        // School Admin / Platform Admin pick up admin tier via
        // everyFunction. Plan typo'd this as HLT-005 but the
        // catalogue's HLT-005 is "Dietary Profiles & Allergens"
        // already in use by Cycle 10; HLT-006 is the new code.
        'HLT-006': ['read', 'write'],
        // REVIEW-P2C3 BLOCKING #1 — school-wide immunisation compliance
        // (list / dashboard / state CSV report) is gated on a dedicated
        // HLT-007 code instead of the broad HLT-001:read held by Parent /
        // Student / Teacher. Staff (nurse) holds read+write; School Admin
        // and Platform Admin pick up admin tier via everyFunction. Per-
        // student self-service via getForStudent(:studentId) keeps using
        // hlt-001:read with relationship enforcement at the service.
        'HLT-007': ['read', 'write'],
        // Cycle 11 — Counselling & Student Support. Staff covers
        // counsellor + VP + admin assistant. Counsellors are the
        // canonical author of caseloads / referrals (COU-001/002),
        // MTSS tier assignments + interventions (COU-003), IEP / 504
        // accommodations (COU-005), and coordinated care notes
        // (COU-007 — gated additionally at the Step 7 service layer
        // on the intersection of hlt-001:read AND cou-007:read).
        // Mandatory reporting (COU-006) is read+write because lead
        // counsellors update CPS responses on filed reports.
        // student_counseling_record:read is the FERPA gate for
        // svc_session_notes content — granted to Staff and Admin
        // ONLY. Teachers and parents NEVER hold this code.
        'COU-001': ['read', 'write'],
        'COU-002': ['read', 'write'],
        'COU-003': ['read', 'write'],
        'COU-005': ['read', 'write'],
        'COU-006': ['read', 'write'],
        'COU-007': ['read', 'write'],
        // Cycle 11.1 — Wellbeing Check-Ins. Counsellors create survey
        // templates, deploy to target audiences, view all check-in
        // detail (full responses + flagged status + alert lifecycle),
        // and triage alerts. Admin tier (school-wide analytics, hard
        // delete) is reached via the everyFunction grant.
        'COU-004': ['read', 'write'],
        student_counseling_record: ['read'],
        // Cycle 12 — Library. Staff covers the librarian (and any
        // other staff who help at the circulation desk). LIB-001
        // read+write so the librarian adds + edits catalogue items,
        // locations, and copies. LIB-002 read+write so the librarian
        // processes the checkout / return / renew / hold-fulfil
        // lifecycle and manages fines (pay / waive). LIB-003 write
        // covers programme + reading list + review moderation
        // (read piggybacks on the librarian's catalogue browse via
        // LIB-001:read). School Admin and Platform Admin pick up
        // the admin tier (catalogue-import, hard-delete, library
        // analytics dashboard) via the everyFunction grant.
        'LIB-001': ['read', 'write'],
        'LIB-002': ['read', 'write'],
        'LIB-003': ['write'],
        // Cycle 13 — Athletics. Staff covers the Athletic Director (AD)
        // and any other staff who help with athletic operations.
        // ATH-001 read+write covers programme + roster management.
        // ATH-002 read+write covers game scheduling, cross-school
        // proposals, results, and player stats entry. ATH-003
        // read+write covers coaching staff assignments and stipend
        // tracking. ATH-004 read+write covers injury logging and the
        // 6-step concussion protocol management. ATH-005 read+write
        // covers physician medical clearance review. School Admin and
        // Platform Admin pick up the admin tier (catalogue-import,
        // hard-delete, athletics analytics) via the everyFunction grant.
        'ATH-001': ['read', 'write'],
        'ATH-002': ['read', 'write'],
        'ATH-003': ['read', 'write'],
        'ATH-004': ['read', 'write'],
        'ATH-005': ['read', 'write'],
        // Cycle 17 — Clubs & Student Life. Staff covers the EO,
        // counsellor, advisor, and admin assistant personas that
        // manage activities, plan field trips, run elections, approve
        // service hours. CLB-001..004 read+write cover the full
        // operational surface; School Admin and Platform Admin pick
        // up the admin tier (election publish results, hard delete)
        // via the everyFunction grant.
        'CLB-001': ['read', 'write'],
        'CLB-002': ['read', 'write'],
        'CLB-003': ['read', 'write'],
        'CLB-004': ['read', 'write'],
        // Cycle 18 — Groups & Communities. Staff create + manage
        // groups school-wide; admins additionally hold GRP-001:admin
        // via everyFunction.
        'GRP-001': ['read', 'write'],
        // Cycle 19 — Transportation. Staff covers the Transportation
        // Coordinator (TC) — the sixth specialist operator persona.
        // TRN-001..005 read+write covers the full TC operational
        // surface (route management, fleet management, driver
        // operations, driver credentials, field-trip + special-trip
        // approval). School Admin and Platform Admin pick up the
        // admin tier (catalogue import, hard delete) via
        // everyFunction. Joins the broader role-split work in the
        // Wave 2 Phase 2 punch list — a dedicated TC role should
        // hold the TRN-* codes alone before pilot.
        'TRN-001': ['read', 'write'],
        'TRN-002': ['read', 'write'],
        'TRN-003': ['read', 'write'],
        'TRN-004': ['read', 'write'],
        'TRN-005': ['read', 'write'],
        // Cycle 20 — Food Service. Staff covers the Food Service
        // Manager (FSM) — the seventh specialist operator persona.
        // FDS-001..004 read+write covers menus / POS / dietary /
        // safety operations. Joins the broader role-split work in
        // the Wave 2 Phase 2 punch list — a dedicated FSM role
        // should hold the FDS-* codes alone before pilot. School
        // Admin and Platform Admin pick up the admin tier (USDA
        // claim approval, hard delete) via everyFunction.
        'FDS-001': ['read', 'write'],
        'FDS-002': ['read', 'write'],
        'FDS-003': ['read', 'write'],
        'FDS-004': ['read', 'write'],
        // Cycle 21 — Facilities Management. Staff covers the
        // Facilities Manager (FM) — the eighth specialist operator
        // persona. Per REVIEW-CYCLE21 BLOCKING 1, the FAC-001 admin
        // tier separates FM authority (manage buildings + spaces +
        // closures) from the broader teacher booking authority
        // (FAC-001:read+write). Staff therefore carries
        // FAC-001..004 read+write+admin for the FM stand-in.
        // FAC-005 (energy / sustainability) is schema-ready but
        // deferred this cycle. Joins the role-split work in the
        // Phase 2 punch list — a dedicated FM role should hold the
        // FAC-* codes alone before pilot. School Admin / Platform
        // Admin pick up admin tier via everyFunction.
        'FAC-001': ['read', 'write', 'admin'],
        'FAC-002': ['read', 'write', 'admin'],
        'FAC-003': ['read', 'write', 'admin'],
        'FAC-004': ['read', 'write', 'admin'],
        // Cycle 22 — IT Infrastructure. Staff covers the IT
        // Administrator (IT admin) — the ninth specialist operator
        // persona. IT-002..006 read+write covers asset fleet
        // management, device selection workflow approval / provisioning,
        // licence + seat tracking, credential vault management
        // (CredentialVaultService.getById refuses to decrypt when
        // actor tier < credential tier so STANDARD-tier Staff still
        // can't read CRITICAL credentials), and MDM compliance
        // dashboard. Joins the role-split work in the Phase 2 punch
        // list — a dedicated IT admin role should hold the IT-* codes
        // alone before pilot. School Admin / Platform Admin pick up
        // the admin tier (DELETE on credentials, hard-clean operations)
        // via everyFunction.
        'IT-002': ['read', 'write'],
        'IT-003': ['read', 'write'],
        'IT-004': ['read', 'write'],
        'IT-005': ['read', 'write'],
        'IT-006': ['read', 'write'],
        // Cycle 26 — Finance & Accounting. Staff covers the CFO /
        // Business Manager — the tenth specialist operator persona.
        // FIN-005..008 are NEW catalogue codes (see permissions.json
        // — distinct from the existing FIN-001..004 family-billing
        // codes from Cycle 6 to avoid leaking GL access to parents
        // who already hold FIN-001:read+write).
        //   FIN-005 = General Ledger + Chart of Accounts + Periods
        //   FIN-006 = Operating Budgets
        //   FIN-007 = Accounts Payable (vouchers + payments)
        //   FIN-008 = Reconciliation + Board Reports + Grants
        // School Admin and Platform Admin pick up the admin tier
        // (period LOCK, board report generation, grant close) via
        // everyFunction. Joins the role-split work in the Phase 2
        // punch list — a dedicated CFO role should hold the FIN-*
        // codes alone before pilot.
        'FIN-005': ['read', 'write'],
        'FIN-006': ['read', 'write'],
        'FIN-007': ['read', 'write'],
        'FIN-008': ['read', 'write'],
        // Cycle 27 — Procurement. Staff covers the Procurement
        // Officer / Purchasing Clerk — the eleventh specialist
        // operator persona. PRC-001..003 read+write covers the
        // full operational surface: requisitions (PRC-001),
        // purchase orders + receiving (PRC-002), distribution +
        // returns + vendor performance (PRC-003). School Admin /
        // Platform Admin pick up the admin tier (close PO,
        // override commitments) via everyFunction. Joins items
        // 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 /
        // 34 / 35 / 36 / 37 / 38 / 39 / 40 in the broader
        // role-split chain — a dedicated Procurement Officer
        // role should hold the PRC-* codes alone before pilot.
        'PRC-001': ['read', 'write'],
        'PRC-002': ['read', 'write'],
        'PRC-003': ['read', 'write'],
        // Cycle 28 — School Store. Staff covers the store manager —
        // the twelfth specialist operator persona. STR-001..003
        // read+write covers the full operational surface: products
        // + inventory (STR-001), order fulfilment + parent approval
        // proxy (STR-002 — Staff can fulfil and ship; parent
        // approve/decline lives at STR-002:write held by Parent +
        // admin), external customers + shipping + revenue + store
        // management (STR-003). School Admin / Platform Admin pick
        // up the admin tier (close store, override prices) via
        // everyFunction. Joins the broader role-split chain — a
        // dedicated Store Manager role should hold the STR-* codes
        // alone before pilot.
        'STR-001': ['read', 'write'],
        'STR-002': ['read', 'write'],
        'STR-003': ['read', 'write'],
        // Cycle 29 — Analytics. Staff (principal/VP/counsellor stand-in)
        // gets the full read surface plus the report engine + scheduling
        // tier. RPT-001 (class) + RPT-002 (school + at-risk) + RPT-004
        // (report engine + scheduling) read+write. RPT-003 (district)
        // is admin-only via everyFunction so superintendents — modeled
        // as School Admin or Platform Admin in the demo seed — keep the
        // district dashboard scope. Pre-pilot work splits the
        // counsellor / principal / VP into dedicated roles so the
        // at-risk dashboard isn't visible to a generic Staff member.
        'RPT-001': ['read', 'write'],
        'RPT-002': ['read', 'write'],
        'RPT-004': ['read', 'write'],
        // Cycle 30 — Data Protection. Staff covers the Data Protection
        // Officer (DPO) — the thirteenth specialist operator persona.
        // DPO-001..005 read+write covers the full operational surface:
        // ROPA + retention + DPIA (DPO-001), processors + DPAs (DPO-002),
        // breach management (DPO-003), SARs + erasure (DPO-004), consent
        // + privacy notices (DPO-005). School Admin / Platform Admin
        // pick up the admin tier (delete records, override status) via
        // everyFunction. Joins the broader role-split chain — a
        // dedicated DPO role scoped at ORGANISATION level should hold
        // the DPO-* codes alone before pilot per ADR-052 + the plan.
        'DPO-001': ['read', 'write'],
        'DPO-002': ['read', 'write'],
        'DPO-003': ['read', 'write'],
        'DPO-004': ['read', 'write'],
        'DPO-005': ['read', 'write'],
      },
    },

    // ─── REVIEW-FINAL P1 — Specialist role permission specs ──────
    // Each specialist role gets the function codes for its domain
    // at read+write+admin tier. The Platform Admin reconciliation
    // upstream gives Platform Admin everything; specialists are the
    // narrow alternative for real-school staff who shouldn't need
    // platform-level authority.
    //
    // Specs are additive against the base catalogue — codes that
    // don't exist (e.g. ATH-006..010 if the catalogue ships only
    // ATH-001..005) silently skip via the permIdByCode lookup.

    // Vice Principal — cross-functional read access + key ops admin.
    // Used for staff who help run the school but aren't the
    // designated School Admin (the Principal).
    {
      roleName: 'Vice Principal',
      perms: {
        'STU-001': ['read', 'write', 'admin'],
        'STU-002': ['read', 'write', 'admin'],
        'STU-003': ['read', 'write'],
        // P2-5 — VP often handles withdrawal + re-enrolment when EO
        // is unavailable.
        'STU-004': ['read', 'write', 'admin'],
        'ATT-001': ['read', 'write', 'admin'],
        'ATT-002': ['read', 'write'],
        'ATT-003': ['read', 'write'],
        'ATT-004': ['read', 'write'],
        'ATT-005': ['read', 'write'],
        'BEH-001': ['read', 'write', 'admin'],
        'BEH-002': ['read', 'write'],
        'COM-001': ['read', 'write'],
        'COM-002': ['read', 'write', 'admin'],
        'COM-003': ['read', 'write', 'admin'],
        'COM-004': ['read', 'write', 'admin'],
        'TCH-001': ['read', 'write'],
        'TCH-002': ['read', 'write'],
        'TCH-003': ['read', 'write'],
        'TCH-004': ['read', 'write'],
        'TCH-005': ['read', 'write'],
        'TCH-006': ['read', 'write'],
        'TCH-007': ['read', 'write'],
        'TCH-008': ['read', 'write'],
        'OPS-001': ['read', 'write'],
        'IT-001': ['read', 'write'],
      },
    },

    // Counsellor — student counselling specialist.
    {
      roleName: 'Counsellor',
      perms: {
        'COU-001': ['read', 'write', 'admin'],
        'COU-002': ['read', 'write', 'admin'],
        'COU-003': ['read', 'write', 'admin'],
        'COU-004': ['read', 'write', 'admin'],
        'COU-005': ['read', 'write', 'admin'],
        'COU-006': ['read', 'write', 'admin'],
        'COU-007': ['read', 'write', 'admin'],
        student_counseling_record: ['read'],
        // Counsellors need basic student visibility + meetings.
        'STU-001': ['read'],
        'STU-002': ['read'],
        'BEH-001': ['read', 'write'],
        'BEH-002': ['read', 'write', 'admin'],
        'MTG-001': ['read', 'write'],
        'MTG-002': ['read', 'write'],
        'COM-001': ['read', 'write'],
      },
    },

    // Nurse — health module specialist.
    {
      roleName: 'Nurse',
      perms: {
        'HLT-001': ['read', 'write', 'admin'],
        'HLT-002': ['read', 'write', 'admin'],
        'HLT-003': ['read', 'write', 'admin'],
        'HLT-004': ['read', 'write', 'admin'],
        'HLT-005': ['read', 'write', 'admin'],
        // Coordinated care intersection requires both health + counselling read.
        'COU-007': ['read'],
        'STU-001': ['read'],
        'MTG-001': ['read', 'write'],
        'COM-001': ['read', 'write'],
      },
    },

    // Librarian — catalogue + circulation + reading programmes.
    {
      roleName: 'Librarian',
      perms: {
        'LIB-001': ['read', 'write', 'admin'],
        'LIB-002': ['read', 'write', 'admin'],
        'LIB-003': ['read', 'write', 'admin'],
        'STU-001': ['read'],
        'COM-001': ['read', 'write'],
      },
    },

    // Athletic Director — sports programmes + clearances.
    {
      roleName: 'Athletic Director',
      perms: {
        'ATH-001': ['read', 'write', 'admin'],
        'ATH-002': ['read', 'write', 'admin'],
        'ATH-003': ['read', 'write', 'admin'],
        'ATH-004': ['read', 'write', 'admin'],
        'ATH-005': ['read', 'write', 'admin'],
        'STU-001': ['read'],
        'COM-001': ['read', 'write'],
      },
    },

    // Activities Coordinator — clubs / extracurricular.
    {
      roleName: 'Activities Coordinator',
      perms: {
        'CLB-001': ['read', 'write', 'admin'],
        'CLB-002': ['read', 'write', 'admin'],
        'CLB-003': ['read', 'write', 'admin'],
        'CLB-004': ['read', 'write', 'admin'],
        'STU-001': ['read'],
        'COM-001': ['read', 'write'],
      },
    },

    // Enrolment Officer — admissions pipeline.
    {
      roleName: 'Enrolment Officer',
      perms: {
        'STU-003': ['read', 'write', 'admin'],
        // P2-5 — EO owns the full withdrawal lifecycle, the
        // re-enrolment dashboard for next year's roster, and the
        // mid-year admission queue.
        'STU-004': ['read', 'write', 'admin'],
        'STU-001': ['read'],
        'COM-001': ['read', 'write'],
      },
    },

    // Transportation Coordinator — buses, routes, ridership.
    {
      roleName: 'Transportation Coordinator',
      perms: {
        'TRN-001': ['read', 'write', 'admin'],
        'TRN-002': ['read', 'write', 'admin'],
        'TRN-003': ['read', 'write', 'admin'],
        'TRN-004': ['read', 'write', 'admin'],
        'TRN-005': ['read', 'write', 'admin'],
        'STU-001': ['read'],
        'COM-001': ['read', 'write'],
      },
    },

    // Food Service Manager — meals, allergens, NSLP.
    {
      roleName: 'Food Service Manager',
      perms: {
        'FDS-001': ['read', 'write', 'admin'],
        'FDS-002': ['read', 'write', 'admin'],
        'FDS-003': ['read', 'write', 'admin'],
        'FDS-004': ['read', 'write', 'admin'],
        'STU-001': ['read'],
        'COM-001': ['read', 'write'],
      },
    },

    // Facilities Manager — buildings, work orders, inspections.
    {
      roleName: 'Facilities Manager',
      perms: {
        'FAC-001': ['read', 'write', 'admin'],
        'FAC-002': ['read', 'write', 'admin'],
        'FAC-003': ['read', 'write', 'admin'],
        'FAC-004': ['read', 'write', 'admin'],
        'IT-001': ['read', 'write'], // Helpdesk for facilities tickets.
        'COM-001': ['read', 'write'],
      },
    },

    // IT Administrator — devices, licences, vault.
    {
      roleName: 'IT Administrator',
      perms: {
        'IT-001': ['read', 'write', 'admin'],
        'IT-002': ['read', 'write', 'admin'],
        'IT-003': ['read', 'write', 'admin'],
        'IT-004': ['read', 'write', 'admin'],
        'IT-005': ['read', 'write', 'admin'],
        'IT-006': ['read', 'write', 'admin'],
        'COM-001': ['read', 'write'],
      },
    },

    // Finance Officer — GL, AP, budgets, board reports.
    {
      roleName: 'Finance Officer',
      perms: {
        'FIN-001': ['read', 'write', 'admin'],
        'FIN-002': ['read', 'write', 'admin'],
        'FIN-003': ['read', 'write', 'admin'],
        'FIN-004': ['read', 'write', 'admin'],
        'FIN-005': ['read', 'write', 'admin'],
        'FIN-006': ['read', 'write', 'admin'],
        'FIN-007': ['read', 'write', 'admin'],
        'FIN-008': ['read', 'write', 'admin'],
        'COM-001': ['read', 'write'],
      },
    },

    // Procurement Officer — requisitions, purchase orders, vendors.
    {
      roleName: 'Procurement Officer',
      perms: {
        'PRC-001': ['read', 'write', 'admin'],
        'PRC-002': ['read', 'write', 'admin'],
        'PRC-003': ['read', 'write', 'admin'],
        'COM-001': ['read', 'write'],
      },
    },

    // Store Manager — school store inventory + orders.
    {
      roleName: 'Store Manager',
      perms: {
        'STR-001': ['read', 'write', 'admin'],
        'STR-002': ['read', 'write', 'admin'],
        'STR-003': ['read', 'write', 'admin'],
        'COM-001': ['read', 'write'],
      },
    },

    // Data Protection Officer — GDPR compliance keystone.
    {
      roleName: 'DPO',
      perms: {
        'DPO-001': ['read', 'write', 'admin'],
        'DPO-002': ['read', 'write', 'admin'],
        'DPO-003': ['read', 'write', 'admin'],
        'DPO-004': ['read', 'write', 'admin'],
        'DPO-005': ['read', 'write', 'admin'],
        'COM-001': ['read', 'write'],
      },
    },
  ];

  var allPermissions = await client.permission.findMany({ select: { id: true, code: true } });
  var permIdByCode: Record<string, string> = {};
  for (var pi = 0; pi < allPermissions.length; pi++) {
    var pp = allPermissions[pi]!;
    permIdByCode[pp.code] = pp.id;
  }

  for (var rpi = 0; rpi < rolePermsSpec.length; rpi++) {
    var spec = rolePermsSpec[rpi]!;
    var role = await client.role.findFirst({ where: { name: spec.roleName } });
    if (!role) continue;

    var targetCodes: string[] = [];
    if (spec.everyFunction) {
      for (var ai = 0; ai < allPermissions.length; ai++) {
        var perm = allPermissions[ai]!;
        var tier = perm.code.split(':')[1]!;
        if (spec.everyFunction.indexOf(tier) >= 0) {
          targetCodes.push(perm.code);
        }
      }
    } else if (spec.perms) {
      var funcCodes = Object.keys(spec.perms);
      for (var fci = 0; fci < funcCodes.length; fci++) {
        var fc = funcCodes[fci]!;
        var tiers = spec.perms[fc]!;
        for (var tj = 0; tj < tiers.length; tj++) {
          targetCodes.push(fc.toLowerCase() + ':' + tiers[tj]!);
        }
      }
    }

    var existingRp = await client.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permissionId: true },
    });
    var existingPermIds: Record<string, boolean> = {};
    for (var ei = 0; ei < existingRp.length; ei++) {
      existingPermIds[existingRp[ei]!.permissionId] = true;
    }

    var addCount = 0;
    var newRows: Array<{ id: string; roleId: string; permissionId: string }> = [];
    for (var ti = 0; ti < targetCodes.length; ti++) {
      var code = targetCodes[ti]!;
      var permId = permIdByCode[code];
      if (!permId) continue;
      if (existingPermIds[permId]) continue;
      newRows.push({ id: generateId(), roleId: role.id, permissionId: permId });
      addCount++;
    }
    if (newRows.length > 0) {
      await client.rolePermission.createMany({ data: newRows });
    }
    console.log(
      '  ' +
        spec.roleName +
        ': ' +
        targetCodes.length +
        ' permissions targeted (' +
        addCount +
        ' newly added)',
    );
  }

  // ── 5. Create platform and school scopes ───────────────────
  var platformScopeType = await client.iamScopeType.findUnique({ where: { code: 'PLATFORM' } });
  var schoolScopeType = await client.iamScopeType.findUnique({ where: { code: 'SCHOOL' } });
  var school = await client.school.findFirst({ where: { subdomain: 'demo' } });

  var existingScopes = await client.iamScope.count();
  var platformScopeId: string;
  var schoolScopeId: string;

  if (existingScopes > 0) {
    console.log('  Scopes already seeded');
    var platformScope = await client.iamScope.findFirst({
      where: { scopeTypeId: platformScopeType!.id },
    });
    var schoolScope = await client.iamScope.findFirst({
      where: { scopeTypeId: schoolScopeType!.id, entityId: school!.id },
    });
    platformScopeId = platformScope!.id;
    schoolScopeId = schoolScope!.id;
  } else {
    // Platform scope (root)
    platformScopeId = generateId();
    await client.iamScope.create({
      data: {
        id: platformScopeId,
        scopeTypeId: platformScopeType!.id,
        entityId: platformScopeType!.id,
        entityTable: 'platform',
        label: 'CampusOS Platform',
      },
    });

    // School scope (child of platform)
    schoolScopeId = generateId();
    await client.iamScope.create({
      data: {
        id: schoolScopeId,
        scopeTypeId: schoolScopeType!.id,
        entityId: school!.id,
        entityTable: 'schools',
        label: 'Lincoln Elementary',
        parentScopeId: platformScopeId,
      },
    });
    console.log('  Platform + School scopes created');
  }

  // ── 6. Assign roles to test users ──────────────────────────
  // Per-user idempotent lookup-or-create so adding users / specialist
  // role layers in later cycles doesn't require dropping the existing
  // assignments.
  //
  // REVIEW-FINAL P1 — vp@ and counsellor@ now hold their specialist
  // role IN ADDITION to Staff. The Staff assignment is preserved so
  // the existing CAT scripts (which assume the over-grant set)
  // continue to pass; the specialist role gives operators the proper
  // role to use for new staff and lets us validate the role exists +
  // is wired correctly. Phase 2 cleanup: real-school deployments
  // assign specialist roles directly without Staff, then narrow the
  // Staff role's permission set.
  var userRoleMap: Array<{ email: string; roles: string[]; scopeId: string }> = [
    { email: 'admin@demo.campusos.dev', roles: ['Platform Admin'], scopeId: platformScopeId },
    { email: 'principal@demo.campusos.dev', roles: ['School Admin'], scopeId: schoolScopeId },
    { email: 'teacher@demo.campusos.dev', roles: ['Teacher'], scopeId: schoolScopeId },
    { email: 'student@demo.campusos.dev', roles: ['Student'], scopeId: schoolScopeId },
    { email: 'parent@demo.campusos.dev', roles: ['Parent'], scopeId: schoolScopeId },
    // Cycle 4 Step 0 added these two staff to the platform seed.
    // REVIEW-FINAL P1 — layered specialist roles.
    {
      email: 'vp@demo.campusos.dev',
      roles: ['Staff', 'Vice Principal'],
      scopeId: schoolScopeId,
    },
    {
      email: 'counsellor@demo.campusos.dev',
      roles: ['Staff', 'Counsellor'],
      scopeId: schoolScopeId,
    },
  ];

  var newAssignmentCount = 0;
  var totalAssignmentCount = 0;
  for (var ui = 0; ui < userRoleMap.length; ui++) {
    var mapping = userRoleMap[ui]!;
    var user = await client.platformUser.findFirst({ where: { email: mapping.email } });
    if (!user) continue;
    for (var rli = 0; rli < mapping.roles.length; rli++) {
      var roleName = mapping.roles[rli]!;
      var role = await client.role.findFirst({ where: { name: roleName } });
      if (!role) continue;
      totalAssignmentCount++;

      var existingAssignment = await client.iamRoleAssignment.findFirst({
        where: { accountId: user.id, roleId: role.id, scopeId: mapping.scopeId },
      });
      if (existingAssignment) continue;

      await client.iamRoleAssignment.create({
        data: {
          id: generateId(),
          accountId: user.id,
          roleId: role.id,
          scopeId: mapping.scopeId,
          status: 'ACTIVE',
          source: 'MANUAL',
        },
      });
      newAssignmentCount++;
      console.log('  ' + mapping.email + ' -> ' + roleName);
    }
  }
  if (newAssignmentCount === 0) {
    console.log('  Role assignments already up-to-date (' + totalAssignmentCount + ' total)');
  } else {
    console.log(
      '  ' + newAssignmentCount + ' new assignment(s) added (' + totalAssignmentCount + ' total)',
    );
  }

  console.log('');
  console.log('  IAM seed complete!');
  console.log(
    '  ' +
      functions.length * tiers.length +
      ' permissions, ' +
      roleNames.length +
      ' roles, ' +
      totalAssignmentCount +
      ' assignments',
  );
}

// ── Export for use in main seed, or run standalone ──
export { seedIam };

if (require.main === module) {
  seedIam()
    .then(function () {
      return disconnectAll();
    })
    .then(function () {
      process.exit(0);
    })
    .catch(function (e) {
      console.error('IAM seed failed:', e);
      disconnectAll().then(function () {
        process.exit(1);
      });
    });
}
