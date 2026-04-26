import { config } from "dotenv";
config({ path: ["../../.env.local", "../../.env", ".env"] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';
import { provisionTenant } from './provision-tenant';

async function main() {
  console.log('CampusOS seed script');
  console.log('');

  var client = getPlatformClient();

  // 1. Create test organisation
  var orgId = generateId();
  var existingOrg = await client.organisation.findFirst({
    where: { name: 'Demo School District' },
  });

  var finalOrgId: string;
  if (existingOrg) {
    console.log('  Organisation "Demo School District" already exists');
    finalOrgId = existingOrg.id;
  } else {
    await client.organisation.create({
      data: {
        id: orgId,
        name: 'Demo School District',
        countryCode: 'US',
        orgType: 'DISTRICT',
      },
    });
    console.log('  Organisation "Demo School District" created');
    finalOrgId = orgId;
  }

  // 2. Create test school
  var schoolId = generateId();
  var existingSchool = await client.school.findFirst({
    where: { subdomain: 'demo' },
  });

  var finalSchoolId: string;
  if (existingSchool) {
    console.log('  School "demo" already exists');
    finalSchoolId = existingSchool.id;
  } else {
    await client.school.create({
      data: {
        id: schoolId,
        organisationId: finalOrgId,
        name: 'Lincoln Elementary',
        subdomain: 'demo',
        countryCode: 'US',
        timezone: 'America/Chicago',
        planTier: 'MEDIUM',
        schemaName: 'tenant_demo',
      },
    });
    console.log('  School "Lincoln Elementary" (subdomain: demo) created');
    finalSchoolId = schoolId;
  }

  // 3. Create tenant routing record
  var existingRouting = await client.tenantRouting.findFirst({
    where: { tenantId: finalSchoolId },
  });

  if (existingRouting) {
    console.log('  Tenant routing for demo already exists');
  } else {
    await client.tenantRouting.create({
      data: {
        id: generateId(),
        tenantId: finalSchoolId,
        clusterId: 'primary',
        schemaName: 'tenant_demo',
        isActive: true,
        isFrozen: false,
        maxConnectionsPool: 10,
      },
    });
    console.log('  Tenant routing record created');
  }

  // 4. Provision tenant schema
  try {
    await provisionTenant('demo');
  } catch (e) {
    console.log('  Tenant schema already provisioned');
  }

  console.log('');
  console.log('  Seed complete');
  console.log('  Organisation: Demo School District');
  console.log('  School:       Lincoln Elementary (subdomain: demo)');
  console.log('  Tenant:       tenant_demo');
}

main()
  .then(function() { return disconnectAll(); })
  .then(function() { process.exit(0); })
  .catch(function(e) {
    console.error('Seed failed:', e);
    disconnectAll().then(function() { process.exit(1); });
  });
