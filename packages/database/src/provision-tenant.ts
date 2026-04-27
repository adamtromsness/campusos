import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, executePlatformSQL } from './client';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

var TENANT_MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'tenant', 'migrations');

export async function provisionTenant(subdomain: string): Promise<string> {
  var schemaName = 'tenant_' + subdomain.replace(/-/g, '_').toLowerCase();

  if (!/^tenant_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error('Invalid subdomain: ' + subdomain);
  }

  console.log('Provisioning tenant schema: ' + schemaName);

  await executePlatformSQL('CREATE SCHEMA IF NOT EXISTS "' + schemaName + '"');
  console.log('   Schema created');

  await executePlatformSQL('GRANT ALL ON SCHEMA "' + schemaName + '" TO campusos');
  console.log('   Permissions granted');

  await applyTenantMigrations(schemaName);

  console.log('   Tenant ' + schemaName + ' provisioned successfully');
  return schemaName;
}

async function applyTenantMigrations(schemaName: string): Promise<void> {
  var migrationFiles: string[];

  try {
    migrationFiles = readdirSync(TENANT_MIGRATIONS_DIR)
      .filter(function (f: string) {
        return f.endsWith('.sql');
      })
      .sort();
  } catch (e) {
    console.log('   No tenant migrations found');
    return;
  }

  if (migrationFiles.length === 0) {
    console.log('   No tenant migration files found');
    return;
  }

  await executePlatformSQL('SET search_path TO "' + schemaName + '", platform, public');

  for (var i = 0; i < migrationFiles.length; i++) {
    var file = migrationFiles[i];
    var sql = readFileSync(join(TENANT_MIGRATIONS_DIR, file), 'utf-8');
    console.log('   Applying: ' + file);
    var statements = sql
      .split(';')
      .map(function (s: string) {
        return s.trim();
      })
      .filter(function (s: string) {
        return s.length > 0 && !s.startsWith('--');
      });
    for (var j = 0; j < statements.length; j++) {
      await executePlatformSQL(statements[j]);
    }
  }

  await executePlatformSQL('SET search_path TO platform, public');
  console.log('   ' + migrationFiles.length + ' migration(s) applied');
}

export async function listTenantSchemas(): Promise<string[]> {
  var client = getPlatformClient();
  var result = await client.$queryRawUnsafe<Array<{ schema_name: string }>>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%' ORDER BY schema_name",
  );
  return result.map(function (r) {
    return r.schema_name;
  });
}

export async function dropTenantSchema(schemaName: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Cannot drop tenant schemas in production');
  }
  if (!/^tenant_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error('Invalid tenant schema name: ' + schemaName);
  }
  await executePlatformSQL('DROP SCHEMA IF EXISTS "' + schemaName + '" CASCADE');
  console.log('   Schema ' + schemaName + ' dropped');
}

if (require.main === module) {
  var args = process.argv.slice(2);
  var subdomainArg = args.find(function (a: string) {
    return a.startsWith('--subdomain=');
  });

  if (!subdomainArg) {
    console.log('Usage: tsx provision-tenant.ts --subdomain=<name>');
    process.exit(1);
  }

  var subdomain = subdomainArg.split('=')[1];
  if (!subdomain) {
    console.error('Subdomain cannot be empty');
    process.exit(1);
  }

  provisionTenant(subdomain)
    .then(function () {
      process.exit(0);
    })
    .catch(function (e) {
      console.error('Provisioning failed:', e);
      process.exit(1);
    });
}
