import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

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
    // Backfill location fields if the existing row predates Phase 2.
    if (existingSchool.latitude === null || existingSchool.longitude === null) {
      await client.school.update({
        where: { id: schoolId },
        data: {
          latitude: '39.78500000',
          longitude: '-89.65500000',
          fullAddress: '500 School Lane, Springfield, IL 62701',
        },
      });
      console.log('  Backfilled location fields on demo school');
    }
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
        latitude: '39.78500000',
        longitude: '-89.65500000',
        fullAddress: '500 School Lane, Springfield, IL 62701',
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
    {
      firstName: 'Linda',
      lastName: 'Park',
      email: 'vp@demo.campusos.dev',
      personType: 'STAFF' as const,
    },
    {
      firstName: 'Marcus',
      lastName: 'Hayes',
      email: 'counsellor@demo.campusos.dev',
      personType: 'STAFF' as const,
    },
    {
      // Fresh registration-flow fixture — Alex Thompson lands with no
      // personas, no projections, no family children. Logging in as
      // newuser@demo.campusos.dev should route straight to
      // /getting-started so the persona-registration onboarding cards
      // can be exercised end-to-end.
      firstName: 'Alex',
      lastName: 'Thompson',
      email: 'newuser@demo.campusos.dev',
      personType: 'EXTERNAL' as const,
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

  // ── 5b. Empty family for the registration-flow test user ──
  // Alex Thompson (newuser@demo.campusos.dev) is the dedicated
  // 0-personas fixture. Per the design they get a platform_families
  // row at registration even when they have no children yet, so the
  // /family page loads without a lazy-create on first visit.
  var newuser = await client.platformUser.findUnique({
    where: { email: 'newuser@demo.campusos.dev' },
    select: { id: true, personId: true },
  });
  if (newuser) {
    var newuserHasFamily = await client.familyMember.findUnique({
      where: { personId: newuser.personId },
    });
    if (!newuserHasFamily) {
      var newuserFamilyId = generateId();
      await client.platformFamily.create({
        data: {
          id: newuserFamilyId,
          name: null,
          homeLanguage: 'en',
          mailingAddressSame: true,
          members: {
            create: [
              {
                id: generateId(),
                personId: newuser.personId,
                memberRole: 'HEAD_OF_HOUSEHOLD',
                isPrimaryContact: true,
              },
            ],
          },
        },
      });
      console.log('  Empty family created for newuser@demo.campusos.dev');
    }
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

  // ── 6b. Family structure (Maya's biological parents) ───────
  // Distinct from the household above: this is the biological/legal
  // family graph (platform_person_relationships). David is Maya's
  // biological father (with the auto-reciprocal BIOLOGICAL_CHILD on
  // David's profile); Maya's mother is captured name-only ("Linda
  // Chen") since she has no CampusOS account. Idempotent — guarded on
  // the existing BIOLOGICAL_FATHER row.
  var mayaForRel = await client.iamPerson.findFirst({
    where: { firstName: 'Maya', lastName: 'Chen' },
    select: { id: true },
  });
  var davidForRel = await client.iamPerson.findFirst({
    where: { firstName: 'David', lastName: 'Chen' },
    select: { id: true },
  });
  if (mayaForRel && davidForRel) {
    var existingRel = await client.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid AND relationship_type = 'BIOLOGICAL_FATHER'`,
      mayaForRel.id,
    );
    if (Number(existingRel[0]!.n) === 0) {
      await client.$executeRawUnsafe(
        `INSERT INTO platform.platform_person_relationships
           (id, person_id, related_person_id, relationship_type, is_legal_custody, custody_arrangement, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'BIOLOGICAL_FATHER', true, 'JOINT', $3::uuid)`,
        generateId(),
        mayaForRel.id,
        davidForRel.id,
      );
      await client.$executeRawUnsafe(
        `INSERT INTO platform.platform_person_relationships
           (id, person_id, related_person_id, relationship_type, is_legal_custody, custody_arrangement, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'BIOLOGICAL_CHILD', true, 'JOINT', $2::uuid)`,
        generateId(),
        davidForRel.id,
        mayaForRel.id,
      );
      await client.$executeRawUnsafe(
        `INSERT INTO platform.platform_person_relationships
           (id, person_id, related_person_name, relationship_type, created_by)
         VALUES ($1::uuid, $2::uuid, 'Linda Chen', 'BIOLOGICAL_MOTHER', $3::uuid)`,
        generateId(),
        mayaForRel.id,
        davidForRel.id,
      );
      console.log("  Family structure: David = Maya's biological father; mother = Linda Chen (name-only)");
    }
  }

  // ── 7. Provision tenant schema ─────────────────────────────
  // provisionTenant is idempotent — every CREATE in the tenant
  // migrations uses IF NOT EXISTS, every ALTER uses DROP CONSTRAINT
  // IF EXISTS + ADD pattern. So a re-run on an already-provisioned
  // tenant is a no-op.
  //
  // The earlier `try/catch -> "Tenant schema already provisioned"`
  // pattern was a debugging hazard: a real migration failure (stray
  // ; in a block comment, a column rename collision, etc.) would be
  // silently masked as "already provisioned" and the seed would
  // exit 0 with a partially-applied tenant. Downstream domain seeds
  // would then fail with confusing `relation does not exist` errors
  // far from the real cause.
  //
  // Now we let provision errors propagate. Re-running an already-
  // provisioned tenant succeeds because every statement is idempotent.
  await provisionTenant('demo');

  console.log('');
  console.log('  Seed complete!');
  console.log('');
  console.log('  8 users:');
  console.log('    admin@demo.campusos.dev      (Platform Admin)');
  console.log('    principal@demo.campusos.dev  (School Admin)');
  console.log('    teacher@demo.campusos.dev    (Teacher)');
  console.log('    student@demo.campusos.dev    (Student)');
  console.log('    parent@demo.campusos.dev     (Parent)');
  console.log('    vp@demo.campusos.dev         (Vice Principal)');
  console.log('    counsellor@demo.campusos.dev (Counsellor)');
  console.log('    newuser@demo.campusos.dev    (0 personas — Getting Started flow)');
  console.log('');
  console.log('  1 family: Chen (David + Maya)');
  console.log('  1 IdP: Keycloak Dev');
}

main()
  .then(function () {
    return disconnectAll();
  })
  .then(function () {
    process.exit(0);
  })
  .catch(function (e) {
    console.error('Seed failed:', e);
    disconnectAll().then(function () {
      process.exit(1);
    });
  });
