import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Seeds the IAM subsystem:
 * 1. Permission catalogue (148 functions x 3 tiers = 444 permissions)
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
  var roleNames = ['Platform Admin', 'School Admin', 'Teacher', 'Student', 'Parent', 'Staff'];
  var existingRoles = await client.role.count();
  if (existingRoles > 0) {
    console.log('  Roles already seeded');
  } else {
    for (var ri = 0; ri < roleNames.length; ri++) {
      await client.role.create({
        data: {
          id: generateId(),
          name: roleNames[ri]!,
          description: roleNames[ri]! + ' system role',
          isSystem: true,
        },
      });
    }
    console.log('  ' + roleNames.length + ' default roles seeded');
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
        'COM-001': ['read', 'write'],
        'COM-002': ['read', 'write'],
        'SCH-001': ['read'],
        'SCH-003': ['read'],
        // Cycle 5 — coverage read so a teacher sees their own coverage,
        // room booking read+write so they can request and manage rooms.
        'SCH-004': ['read'],
        'SCH-005': ['read', 'write'],
        'BEH-001': ['read', 'write'],
        'COU-002': ['write'],
        // Cycle 4 HR — read directory, manage own leave, view own certs.
        'HR-001': ['read'],
        'HR-003': ['read', 'write'],
        'HR-004': ['read'],
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
        'COM-001': ['read', 'write'],
        'COM-002': ['read'],
        'SCH-003': ['read'],
        // Cycle 6 — Enrollment write so a parent can submit + track an
        // application (row-scoped to their own apps in ApplicationService).
        // Family Billing read for the parent billing dashboard, invoice list,
        // and ledger view; the Pay Now action is gated by the same code at
        // service layer with a row-scope check on family_account ownership.
        'STU-003': ['read', 'write'],
        'FIN-001': ['read'],
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
        'COM-001': ['read', 'write'],
        'COM-002': ['read'],
        'SCH-003': ['read'],
      },
    },
    {
      roleName: 'Staff',
      perms: {
        'STU-001': ['read'],
        'ATT-001': ['read'],
        'COM-001': ['read', 'write'],
        'COM-002': ['read'],
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
        'HR-003': ['read', 'write'],
        'HR-004': ['read'],
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
  // Per-user idempotent lookup-or-create so adding users in later cycles
  // (vp@, counsellor@ in Cycle 4 Step 0) doesn't require dropping the
  // existing assignments.
  var userRoleMap = [
    { email: 'admin@demo.campusos.dev', role: 'Platform Admin', scopeId: platformScopeId },
    { email: 'principal@demo.campusos.dev', role: 'School Admin', scopeId: schoolScopeId },
    { email: 'teacher@demo.campusos.dev', role: 'Teacher', scopeId: schoolScopeId },
    { email: 'student@demo.campusos.dev', role: 'Student', scopeId: schoolScopeId },
    { email: 'parent@demo.campusos.dev', role: 'Parent', scopeId: schoolScopeId },
    // Cycle 4 Step 0 added these two staff to the platform seed.
    { email: 'vp@demo.campusos.dev', role: 'Staff', scopeId: schoolScopeId },
    { email: 'counsellor@demo.campusos.dev', role: 'Staff', scopeId: schoolScopeId },
  ];

  var newAssignmentCount = 0;
  for (var ui = 0; ui < userRoleMap.length; ui++) {
    var mapping = userRoleMap[ui]!;
    var user = await client.platformUser.findFirst({ where: { email: mapping.email } });
    var role = await client.role.findFirst({ where: { name: mapping.role } });
    if (!user || !role) continue;

    var existing = await client.iamRoleAssignment.findFirst({
      where: { accountId: user.id, roleId: role.id, scopeId: mapping.scopeId },
    });
    if (existing) continue;

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
    console.log('  ' + mapping.email + ' -> ' + mapping.role);
  }
  if (newAssignmentCount === 0) {
    console.log('  Role assignments already seeded');
  }

  console.log('');
  console.log('  IAM seed complete!');
  console.log('  ' + functions.length * tiers.length + ' permissions, 6 roles, 5 assignments');
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
