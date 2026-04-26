import { config } from "dotenv";
config({ path: ["../../.env.local", "../../.env", ".env"] });

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

  // ── 1. Seed permissions ────────────────────────────────────
  var dataPath = join(__dirname, '..', 'data', 'permissions.json');
  var permData = JSON.parse(readFileSync(dataPath, 'utf-8'));
  var functions = permData.functions as Array<{code: string; name: string; group: string}>;
  var tiers = permData.tiers as string[];

  var existingPerms = await client.permission.count();
  if (existingPerms > 0) {
    console.log('  Permissions already seeded (' + existingPerms + ' records)');
  } else {
    var permRecords: Array<{id: string; code: string; resource: string; action: string; description: string}> = [];
    for (var fi = 0; fi < functions.length; fi++) {
      var func = functions[fi]!;
      for (var ti = 0; ti < tiers.length; ti++) {
        var tier = tiers[ti]!;
        var code = func.code.toLowerCase() + ':' + tier;
        permRecords.push({
          id: generateId(),
          code: code,
          resource: func.code.toLowerCase(),
          action: tier,
          description: func.name + ' (' + tier + ')',
        });
      }
    }

    await client.permission.createMany({ data: permRecords });
    console.log('  ' + permRecords.length + ' permissions seeded');
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

  // ── 4. Assign ALL permissions to Platform Admin ────────────
  var adminRole = await client.role.findFirst({ where: { name: 'Platform Admin' } });
  var adminRolePerms = await client.rolePermission.count({ where: { roleId: adminRole!.id } });
  if (adminRolePerms > 0) {
    console.log('  Platform Admin permissions already assigned');
  } else {
    var allPerms = await client.permission.findMany({ select: { id: true } });
    var rpData = allPerms.map(function(p) {
      return { id: generateId(), roleId: adminRole!.id, permissionId: p.id };
    });
    await client.rolePermission.createMany({ data: rpData });
    console.log('  ' + rpData.length + ' permissions assigned to Platform Admin');
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
  var existingAssignments = await client.iamRoleAssignment.count();
  if (existingAssignments > 0) {
    console.log('  Role assignments already seeded');
  } else {
    var userRoleMap = [
      { email: 'admin@demo.campusos.dev', role: 'Platform Admin', scopeId: platformScopeId },
      { email: 'principal@demo.campusos.dev', role: 'School Admin', scopeId: schoolScopeId },
      { email: 'teacher@demo.campusos.dev', role: 'Teacher', scopeId: schoolScopeId },
      { email: 'student@demo.campusos.dev', role: 'Student', scopeId: schoolScopeId },
      { email: 'parent@demo.campusos.dev', role: 'Parent', scopeId: schoolScopeId },
    ];

    for (var ui = 0; ui < userRoleMap.length; ui++) {
      var mapping = userRoleMap[ui]!;
      var user = await client.platformUser.findFirst({ where: { email: mapping.email } });
      var role = await client.role.findFirst({ where: { name: mapping.role } });

      if (user && role) {
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
        console.log('  ' + mapping.email + ' -> ' + mapping.role);
      }
    }
  }

  console.log('');
  console.log('  IAM seed complete!');
  console.log('  ' + (functions.length * tiers.length) + ' permissions, 6 roles, 5 assignments');
}

// ── Export for use in main seed, or run standalone ──
export { seedIam };

if (require.main === module) {
  seedIam()
    .then(function() { return disconnectAll(); })
    .then(function() { process.exit(0); })
    .catch(function(e) {
      console.error('IAM seed failed:', e);
      disconnectAll().then(function() { process.exit(1); });
    });
}
