import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-tickets.ts — Cycle 8 Step 3.
 *
 * Idempotent. Gated on whether tkt_categories already has rows for the demo
 * school. Re-running is a no-op once the seed has landed.
 *
 * Seven sections:
 *   A) 3 top-level tkt_categories — IT, Facilities, HR Support.
 *   B) 11 tkt_subcategories — 4 IT (Hardware, Software, Network, Account
 *      Access) + 5 Facilities (Electrical, Plumbing, HVAC, Cleaning,
 *      Furniture) + 2 HR Support (Payroll Question, Benefits Question).
 *      IT/Hardware gets default_assignee_id = principal (Sarah Mitchell, who
 *      stands in as the IT admin for the demo); Facilities/Electrical gets
 *      auto_assign_to_role = SCHOOL_ADMIN to exercise the role-resolution
 *      path. The other 9 land in the admin queue unassigned by default.
 *   C) 12 SLA policies — 3 categories × 4 priorities. CRITICAL 1h/4h,
 *      HIGH 2h/8h, MEDIUM 4h/24h, LOW 8h/72h. Same shape across all 3
 *      categories; in production each school would tune per category.
 *   D) 2 vendors — Springfield IT Solutions (IT_REPAIR, is_preferred=true,
 *      contact info) and Lincoln Maintenance Co (FACILITIES_MAINTENANCE,
 *      contact info, not preferred since it is the only facilities vendor).
 *   E) 5 sample tickets covering all 5 lifecycle states the schema admits
 *      (excluding PENDING_REQUESTER which is reserved for the future
 *      "waiting on user reply" branch). Plus 3 sample comments and 8
 *      activity rows tracing their lifecycle transitions.
 *   F) 1 sample problem "Network switch failure in Building A" linking
 *      tickets 1 and 3, status=INVESTIGATING.
 *   G) 1 auto-task rule on tkt.ticket.assigned — feeds the existing Cycle
 *      7 Task Worker so a newly-assigned ticket creates a TODO task on the
 *      assignee's list. Priority HIGH, ADMINISTRATIVE category, due offset
 *      24h from the SLA policy's resolution_hours (the auto-task default;
 *      Step 4 TicketService can pass the per-ticket SLA hours via the event
 *      payload for finer granularity later).
 */

const TENANT_SCHEMA = 'tenant_demo';
const TODAY_ISO = new Date().toISOString();

async function seedTickets() {
  console.log('');
  console.log('  Tickets Seed (Cycle 8 Step 3 — Categories + SLA + Vendors + Sample Tickets)');
  console.log('');

  const client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  async function findUserId(email: string): Promise<string> {
    const u = await client.platformUser.findUnique({ where: { email }, select: { id: true } });
    if (!u) throw new Error('platform_users not found for ' + email);
    return u.id;
  }

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

  const [principalUserId, teacherUserId, vpUserId, counsellorUserId] = await Promise.all([
    findUserId('principal@demo.campusos.dev'),
    findUserId('teacher@demo.campusos.dev'),
    findUserId('vp@demo.campusos.dev'),
    findUserId('counsellor@demo.campusos.dev'),
  ]);

  const [principalEmpId, vpEmpId] = await Promise.all([
    findEmployeeId('principal@demo.campusos.dev'),
    findEmployeeId('vp@demo.campusos.dev'),
  ]);

  // Idempotency gate — checks tkt_categories for the demo school.
  const existingCats = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.tkt_categories WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existingCats[0] && existingCats[0].c > 0) {
    console.log('  tkt_categories already populated for demo school — skipping');
    return;
  }

  // ── 2. Categories + subcategories ─────────────────────────────
  console.log('  A) categories:');
  const itCategoryId = generateId();
  const facCategoryId = generateId();
  const hrCategoryId = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_categories (id, school_id, name, icon) VALUES ' +
      '($1::uuid, $2::uuid, $3, $4), ' +
      '($5::uuid, $2::uuid, $6, $7), ' +
      '($8::uuid, $2::uuid, $9, $10)',
    itCategoryId,
    schoolId,
    'IT',
    'computer',
    facCategoryId,
    'Facilities',
    'wrench',
    hrCategoryId,
    'HR Support',
    'people',
  );
  console.log('     - IT, Facilities, HR Support');

  console.log('  B) subcategories:');
  interface SubcategorySpec {
    parentId: string;
    name: string;
    defaultAssigneeId?: string;
    autoAssignToRole?: string;
  }
  const subcatSpecs: SubcategorySpec[] = [
    { parentId: itCategoryId, name: 'Hardware', defaultAssigneeId: principalEmpId },
    { parentId: itCategoryId, name: 'Software' },
    { parentId: itCategoryId, name: 'Network' },
    { parentId: itCategoryId, name: 'Account Access' },
    { parentId: facCategoryId, name: 'Electrical', autoAssignToRole: 'SCHOOL_ADMIN' },
    { parentId: facCategoryId, name: 'Plumbing' },
    { parentId: facCategoryId, name: 'HVAC' },
    { parentId: facCategoryId, name: 'Cleaning' },
    { parentId: facCategoryId, name: 'Furniture' },
    { parentId: hrCategoryId, name: 'Payroll Question' },
    { parentId: hrCategoryId, name: 'Benefits Question' },
  ];

  // Map name -> id so later sections can reference by name without another lookup.
  const subcatIdByName: Record<string, string> = {};

  for (const spec of subcatSpecs) {
    const id = generateId();
    subcatIdByName[spec.name] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tkt_subcategories (id, category_id, name, default_assignee_id, auto_assign_to_role) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)',
      id,
      spec.parentId,
      spec.name,
      spec.defaultAssigneeId ?? null,
      spec.autoAssignToRole ?? null,
    );
  }
  console.log(
    '     - 11 subcategories (IT/Hardware → default Sarah Mitchell, Facilities/Electrical → role SCHOOL_ADMIN)',
  );

  // ── 3. SLA policies ───────────────────────────────────────────
  console.log('  C) SLA policies:');
  const slaTargets: Array<{ priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; resp: number; res: number }> = [
    { priority: 'CRITICAL', resp: 1, res: 4 },
    { priority: 'HIGH', resp: 2, res: 8 },
    { priority: 'MEDIUM', resp: 4, res: 24 },
    { priority: 'LOW', resp: 8, res: 72 },
  ];

  // Map (categoryId, priority) -> sla_policy_id for the sample tickets to link.
  const slaIdByCategoryPriority: Record<string, string> = {};

  for (const cat of [
    { id: itCategoryId, label: 'IT' },
    { id: facCategoryId, label: 'Facilities' },
    { id: hrCategoryId, label: 'HR Support' },
  ]) {
    for (const t of slaTargets) {
      const id = generateId();
      slaIdByCategoryPriority[cat.id + ':' + t.priority] = id;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.tkt_sla_policies (id, school_id, category_id, priority, response_hours, resolution_hours) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
        id,
        schoolId,
        cat.id,
        t.priority,
        t.resp,
        t.res,
      );
    }
  }
  console.log('     - 12 policies (3 categories × 4 priorities). CRITICAL 1h/4h … LOW 8h/72h');

  // ── 4. Vendors ────────────────────────────────────────────────
  console.log('  D) vendors:');
  const vendorItId = generateId();
  const vendorFacId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_vendors (id, school_id, vendor_name, vendor_type, contact_name, contact_email, contact_phone, website, is_preferred, notes) ' +
      'VALUES ' +
      '($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, true, $9), ' +
      '($10::uuid, $2::uuid, $11, $12, $13, $14, $15, $16, false, $17)',
    vendorItId,
    schoolId,
    'Springfield IT Solutions',
    'IT_REPAIR',
    'Patricia Nguyen',
    'support@springfield-it.example',
    '+1-217-555-0420',
    'https://springfield-it.example',
    'Preferred IT vendor — quick turnaround on hardware repairs.',
    vendorFacId,
    'Lincoln Maintenance Co',
    'FACILITIES_MAINTENANCE',
    'Greg Owens',
    'dispatch@lincoln-maintenance.example',
    '+1-217-555-0451',
    'https://lincoln-maintenance.example',
    'Local maintenance company. Lighting and general repairs.',
  );
  console.log('     - Springfield IT Solutions (preferred IT_REPAIR), Lincoln Maintenance Co (FACILITIES_MAINTENANCE)');

  // ── 5. Sample tickets + comments + activity ───────────────────
  console.log('  E) sample tickets:');
  // Back-date created_at so we can build a coherent timeline. The base date
  // is 2026-04-15 so the activity rows all land in the 2026-04 calendar.
  const t1Created = '2026-04-15 09:00:00+00';
  const t2Created = '2026-04-15 10:30:00+00';
  const t3Created = '2026-04-12 14:00:00+00';
  const t4Created = '2026-04-13 11:00:00+00';
  const t5Created = '2026-04-08 13:00:00+00';

  // Ticket 1: Projector — IT/Hardware — HIGH — OPEN — assigned to Mitchell
  const t1Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_tickets (id, school_id, category_id, subcategory_id, requester_id, assignee_id, title, description, priority, status, sla_policy_id, created_at, updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, 'HIGH', 'OPEN', $9::uuid, $10::timestamptz, $10::timestamptz)",
    t1Id,
    schoolId,
    itCategoryId,
    subcatIdByName['Hardware'],
    teacherUserId,
    principalEmpId,
    'Projector not working in Room 101',
    'No image on the projector. Lamp lights up but the input shows a black screen across HDMI 1 and 2.',
    slaIdByCategoryPriority[itCategoryId + ':HIGH'],
    t1Created,
  );

  // Ticket 2: Leaking faucet — Facilities/Plumbing — MEDIUM — IN_PROGRESS — assigned to Mitchell
  const t2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_tickets (id, school_id, category_id, subcategory_id, requester_id, assignee_id, title, description, priority, status, sla_policy_id, first_response_at, created_at, updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, 'MEDIUM', 'IN_PROGRESS', $9::uuid, $10::timestamptz, $11::timestamptz, $10::timestamptz)",
    t2Id,
    schoolId,
    facCategoryId,
    subcatIdByName['Plumbing'],
    vpUserId,
    principalEmpId,
    'Leaking faucet in staff bathroom',
    'The hot-water tap on the left sink drips constantly. Started yesterday afternoon.',
    slaIdByCategoryPriority[facCategoryId + ':MEDIUM'],
    '2026-04-15 11:15:00+00',
    t2Created,
  );

  // Ticket 3: Gradebook access — IT/Software — HIGH — RESOLVED
  const t3Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_tickets (id, school_id, category_id, subcategory_id, requester_id, assignee_id, title, description, priority, status, sla_policy_id, first_response_at, resolved_at, created_at, updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, 'HIGH', 'RESOLVED', $9::uuid, $10::timestamptz, $11::timestamptz, $12::timestamptz, $11::timestamptz)",
    t3Id,
    schoolId,
    itCategoryId,
    subcatIdByName['Software'],
    teacherUserId,
    principalEmpId,
    "Can't access gradebook",
    'Login redirects to a permissions error after switching to the new term.',
    slaIdByCategoryPriority[itCategoryId + ':HIGH'],
    '2026-04-12 14:45:00+00',
    '2026-04-12 16:30:00+00',
    t3Created,
  );

  // Ticket 4: Hallway light — Facilities/Electrical — LOW — VENDOR_ASSIGNED to Lincoln Maintenance
  const t4Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_tickets (id, school_id, category_id, subcategory_id, requester_id, vendor_id, vendor_reference, vendor_assigned_at, title, description, priority, status, sla_policy_id, first_response_at, created_at, updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::timestamptz, $9, $10, 'LOW', 'VENDOR_ASSIGNED', $11::uuid, $12::timestamptz, $13::timestamptz, $13::timestamptz)",
    t4Id,
    schoolId,
    facCategoryId,
    subcatIdByName['Electrical'],
    counsellorUserId,
    vendorFacId,
    'WO-2026-0451',
    '2026-04-13 13:30:00+00',
    'Light out in hallway B',
    'Two fluorescent tubes are out near classroom B-204. Hallway is noticeably dim.',
    slaIdByCategoryPriority[facCategoryId + ':LOW'],
    '2026-04-13 12:00:00+00',
    t4Created,
  );

  // Ticket 5: Payroll date — HR Support/Payroll Question — LOW — CLOSED
  const t5Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_tickets (id, school_id, category_id, subcategory_id, requester_id, assignee_id, title, description, priority, status, sla_policy_id, first_response_at, resolved_at, closed_at, created_at, updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, 'LOW', 'CLOSED', $9::uuid, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13::timestamptz, $12::timestamptz)",
    t5Id,
    schoolId,
    hrCategoryId,
    subcatIdByName['Payroll Question'],
    teacherUserId,
    principalEmpId,
    'Payroll date question',
    'When does the next payroll run? I want to make sure my direct deposit form lands in time.',
    slaIdByCategoryPriority[hrCategoryId + ':LOW'],
    '2026-04-08 14:00:00+00',
    '2026-04-09 09:30:00+00',
    '2026-04-10 09:00:00+00',
    t5Created,
  );
  console.log('     - 5 tickets across OPEN, IN_PROGRESS, RESOLVED, VENDOR_ASSIGNED, CLOSED');

  // Comments — 3 (1 public on T1 by requester, 1 internal on T2 by admin, 1 resolution on T3 by admin)
  console.log('  E2) comments:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_ticket_comments (id, ticket_id, author_id, body, is_internal, created_at) VALUES ' +
      '($1::uuid, $2::uuid, $3::uuid, $4, false, $5::timestamptz), ' +
      '($6::uuid, $7::uuid, $8::uuid, $9, true, $10::timestamptz), ' +
      '($11::uuid, $12::uuid, $13::uuid, $14, false, $15::timestamptz)',
    generateId(),
    t1Id,
    teacherUserId,
    'It started failing during 3rd period yesterday. The bulb still lights but no image on either input.',
    '2026-04-15 09:30:00+00',
    generateId(),
    t2Id,
    principalUserId,
    'Need to order a P-trap replacement. Logged with maintenance for Friday.',
    '2026-04-15 11:30:00+00',
    generateId(),
    t3Id,
    principalUserId,
    'Cleared the cache and reset the gradebook permissions. Please confirm you can access again.',
    '2026-04-12 16:30:00+00',
  );
  console.log('     - 1 public comment on T1, 1 internal comment on T2, 1 resolution comment on T3');

  // Activity — 8 rows tracing lifecycle transitions across the 5 tickets.
  console.log('  E3) activity:');
  const activitySpecs: Array<{
    ticketId: string;
    actorId: string | null;
    activityType: string;
    metadata: Record<string, unknown>;
    at: string;
  }> = [
    // T1: 1 row — comment landed
    {
      ticketId: t1Id,
      actorId: teacherUserId,
      activityType: 'COMMENT',
      metadata: { is_internal: false },
      at: '2026-04-15 09:30:00+00',
    },
    // T2: 2 rows — STATUS_CHANGE OPEN→IN_PROGRESS, COMMENT (internal)
    {
      ticketId: t2Id,
      actorId: principalUserId,
      activityType: 'STATUS_CHANGE',
      metadata: { from: 'OPEN', to: 'IN_PROGRESS' },
      at: '2026-04-15 11:15:00+00',
    },
    {
      ticketId: t2Id,
      actorId: principalUserId,
      activityType: 'COMMENT',
      metadata: { is_internal: true },
      at: '2026-04-15 11:30:00+00',
    },
    // T3: 2 rows — STATUS_CHANGE OPEN→RESOLVED, COMMENT (resolution)
    {
      ticketId: t3Id,
      actorId: principalUserId,
      activityType: 'STATUS_CHANGE',
      metadata: { from: 'OPEN', to: 'RESOLVED' },
      at: '2026-04-12 16:30:00+00',
    },
    {
      ticketId: t3Id,
      actorId: principalUserId,
      activityType: 'COMMENT',
      metadata: { is_internal: false },
      at: '2026-04-12 16:30:00+00',
    },
    // T4: 2 rows — VENDOR_ASSIGNMENT, REASSIGNMENT
    {
      ticketId: t4Id,
      actorId: principalUserId,
      activityType: 'VENDOR_ASSIGNMENT',
      metadata: { vendor_id: vendorFacId, vendor_reference: 'WO-2026-0451' },
      at: '2026-04-13 13:30:00+00',
    },
    {
      ticketId: t4Id,
      actorId: principalUserId,
      activityType: 'REASSIGNMENT',
      metadata: { from_assignee_id: null, to_vendor_id: vendorFacId },
      at: '2026-04-13 13:30:00+00',
    },
    // T5: 1 row — STATUS_CHANGE OPEN→CLOSED via the 3-step roll-up
    {
      ticketId: t5Id,
      actorId: principalUserId,
      activityType: 'STATUS_CHANGE',
      metadata: { from: 'OPEN', to: 'CLOSED' },
      at: '2026-04-10 09:00:00+00',
    },
  ];
  for (const a of activitySpecs) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tkt_ticket_activity (id, ticket_id, actor_id, activity_type, metadata, created_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::timestamptz)',
      generateId(),
      a.ticketId,
      a.actorId,
      a.activityType,
      JSON.stringify(a.metadata),
      a.at,
    );
  }
  console.log('     - 8 activity rows tracing T1 (1) + T2 (2) + T3 (2) + T4 (2) + T5 (1)');

  // ── 6. Sample problem ─────────────────────────────────────────
  console.log('  F) problem:');
  const problemId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      ".tkt_problems (id, school_id, title, description, category_id, status, assigned_to_id, created_by, created_at) " +
      "VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'INVESTIGATING', $6::uuid, $7::uuid, $8::timestamptz)",
    problemId,
    schoolId,
    'Network switch failure in Building A',
    'Several IT tickets in Building A point to intermittent network drops. Investigating the core switch on floor 2 as the likely common cause.',
    itCategoryId,
    principalEmpId,
    principalUserId,
    '2026-04-15 12:00:00+00',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tkt_problem_tickets (id, problem_id, ticket_id) VALUES ' +
      '($1::uuid, $2::uuid, $3::uuid), ' +
      '($4::uuid, $2::uuid, $5::uuid)',
    generateId(),
    problemId,
    t1Id,
    generateId(),
    t3Id,
  );
  console.log('     - "Network switch failure in Building A" linking T1 (Projector) + T3 (Gradebook access)');

  // ── 7. Auto-task rule on tkt.ticket.assigned ──────────────────
  console.log('  G) auto-task rule:');
  const ruleId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tsk_auto_task_rules (id, school_id, trigger_event_type, target_role, title_template, description_template, priority, due_offset_hours, task_category, is_system, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, 'tkt.ticket.assigned', NULL, $3, $4, 'HIGH', 24, 'ADMINISTRATIVE', true, true)",
    ruleId,
    schoolId,
    'Resolve ticket: {ticket_title}',
    'SLA: {resolution_hours}h. Priority: {priority}.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tsk_auto_task_actions (id, rule_id, action_type, action_config, sort_order) ' +
      "VALUES ($1::uuid, $2::uuid, 'CREATE_TASK', '{}'::jsonb, 0)",
    generateId(),
    ruleId,
  );
  console.log('     - tkt.ticket.assigned rule (HIGH priority, ADMINISTRATIVE, 24h offset, CREATE_TASK action)');

  console.log('');
  console.log('  Tickets seed complete. ' + TODAY_ISO);
}

seedTickets()
  .then(() => disconnectAll())
  .catch(async (err) => {
    console.error(err);
    await disconnectAll();
    process.exit(1);
  });
