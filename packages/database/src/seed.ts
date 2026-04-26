import { config } from "dotenv";
config({ path: ["../../.env.local", "../../.env", ".env"] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';
import { provisionTenant } from './provision-tenant';

async function main() {
  console.log('CampusOS seed script');
  console.log('');

  var client = getPlatformClient();

  // ── 1. Organisation ────────────────────────────────────────
  var existingOrg = await client.organisation.findFirst({
    where: { name: 'Demo School District' },
  });

  var orgId: string;
  if (existingOrg) {
    console.log('  Organisation "Demo School District" already exists');
    orgId = existingOrg.id;
  } else {
    orgId = generateId();
    await client.organisation.create({
      data: {
        id: orgId,
        name: 'Demo School District',
        countryCode: 'US',
        orgType: 'DISTRICT',
      },
    });
    console.log('  Organisation "Demo School District" created');
  }

  // ── 2. School ──────────────────────────────────────────────
  var existingSchool = await client.school.findFirst({
    where: { subdomain: 'demo' },
  });

  var schoolId: string;
  if (existingSchool) {
    console.log('  School "demo" already exists');
    schoolId = existingSchool.id;
  } else {
    schoolId = generateId();
    await client.school.create({
      data: {
        id: schoolId,
        organisationId: orgId,
        name: 'Lincoln Elementary',
        subdomain: 'demo',
        countryCode: 'US',
        timezone: 'America/Chicago',
        planTier: 'MEDIUM',
        schemaName: 'tenant_demo',
      },
    });
    console.log('  School "Lincoln Elementary" created');
  }

  // ── 3. Tenant Routing ──────────────────────────────────────
  var existingRouting = await client.tenantRouting.findFirst({
    where: { tenantId: schoolId },
  });

  if (existingRouting) {
    console.log('  Tenant routing already exists');
  } else {
    await client.tenantRouting.create({
      data: {
        id: generateId(),
        tenantId: schoolId,
        clusterId: 'primary',
        schemaName: 'tenant_demo',
        isActive: true,
        isFrozen: false,
        maxConnectionsPool: 10,
      },
    });
    console.log('  Tenant routing created');
  }

  // ── 4. Identity Provider (Keycloak for dev) ────────────────
  var existingIdp = await client.identityProvider.findFirst({
    where: { name: 'Keycloak Dev' },
  });

  var idpId: string;
  if (existingIdp) {
    console.log('  Identity provider already exists');
    idpId = existingIdp.id;
  } else {
    idpId = generateId();
    await client.identityProvider.create({
      data: {
        id: idpId,
        schoolId: schoolId,
        name: 'Keycloak Dev',
        providerType: 'OIDC',
        issuerUrl: 'http://localhost:8080/realms/campusos',
        isActive: true,
        trustLevel: 'HIGH',
        autoProvisionAccounts: true,
      },
    });
    console.log('  Identity provider "Keycloak Dev" created');
  }

  // ── 5. Test Users (iam_person + platform_users) ────────────
  var testUsers = [
    {
      firstName: 'Platform',
      lastName: 'Admin',
      email: 'admin@demo.campusos.dev',
      personType: 'STAFF' as const,
    },
    {
      firstName: 'Sarah',
      lastName: 'Mitchell',
      email: 'principal@demo.campusos.dev',
      personType: 'STAFF' as const,
    },
    {
      firstName: 'James',
      lastName: 'Rivera',
      email: 'teacher@demo.campusos.dev',
      personType: 'STAFF' as const,
    },
    {
      firstName: 'Maya',
      lastName: 'Chen',
      email: 'student@demo.campusos.dev',
      personType: 'STUDENT' as const,
    },
    {
      firstName: 'David',
      lastName: 'Chen',
      email: 'parent@demo.campusos.dev',
      personType: 'GUARDIAN' as const,
    },
  ];

  for (var i = 0; i < testUsers.length; i++) {
    var user = testUsers[i]!;
    var existingUser = await client.platformUser.findFirst({
      where: { email: user.email },
    });

    if (existingUser) {
      console.log('  User ' + user.email + ' already exists');
      continue;
    }

    // Create iam_person
    var personId = generateId();
    await client.iamPerson.create({
      data: {
        id: personId,
        firstName: user.firstName,
        lastName: user.lastName,
        personType: user.personType,
        isActive: true,
      },
    });

    // Create platform_users account
    var userId = generateId();
    await client.platformUser.create({
      data: {
        id: userId,
        personId: personId,
        email: user.email,
        displayName: user.firstName + ' ' + user.lastName,
        accountStatus: 'ACTIVE',
        accountType: 'HUMAN',
      },
    });

    // Create student profile if student
    if (user.personType === 'STUDENT') {
      await client.platformStudent.create({
        data: {
          id: generateId(),
          personId: personId,
          firstName: user.firstName,
          lastName: user.lastName,
          isActive: true,
          dataSubjectIsSelf: false,
        },
      });
    }

    console.log('  User ' + user.email + ' created (person + account)');
  }

  // ── 6. Family (Chen family — Maya student + David parent) ──
  var existingFamily = await client.platformFamily.findFirst({
    where: { name: 'Chen Family' },
  });

  if (existingFamily) {
    console.log('  Chen family already exists');
  } else {
    var mayaPerson = await client.iamPerson.findFirst({
      where: { firstName: 'Maya', lastName: 'Chen' },
    });
    var davidPerson = await client.iamPerson.findFirst({
      where: { firstName: 'David', lastName: 'Chen' },
    });

    if (mayaPerson && davidPerson) {
      var familyId = generateId();
      await client.platformFamily.create({
        data: {
          id: familyId,
          name: 'Chen Family',
          members: {
            create: [
              {
                id: generateId(),
                personId: davidPerson.id,
                memberRole: 'PARENT',
                isPrimaryContact: true,
              },
              {
                id: generateId(),
                personId: mayaPerson.id,
                memberRole: 'STUDENT',
                isPrimaryContact: false,
              },
            ],
          },
        },
      });
      console.log('  Chen family created (David=parent, Maya=student)');
    }
  }

  // ── 7. Provision tenant schema ─────────────────────────────
  try {
    await provisionTenant('demo');
  } catch (e) {
    console.log('  Tenant schema already provisioned');
  }

  console.log('');
  console.log('  Seed complete!');
  console.log('');
  console.log('  5 users:');
  console.log('    admin@demo.campusos.dev      (Platform Admin)');
  console.log('    principal@demo.campusos.dev   (School Admin)');
  console.log('    teacher@demo.campusos.dev     (Teacher)');
  console.log('    student@demo.campusos.dev     (Student)');
  console.log('    parent@demo.campusos.dev      (Parent)');
  console.log('');
  console.log('  1 family: Chen (David + Maya)');
  console.log('  1 IdP: Keycloak Dev');
}

main()
  .then(function() { return disconnectAll(); })
  .then(function() { process.exit(0); })
  .catch(function(e) {
    console.error('Seed failed:', e);
    disconnectAll().then(function() { process.exit(1); });
  });
