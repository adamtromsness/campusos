import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, executePlatformSQL } from './client';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

var TENANT_MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'tenant', 'migrations');

/**
 * P2-H5 DEFECT 2: the 12 IMMUTABLE tables per ADR-010. Triggers prevent
 * UPDATE/DELETE at runtime, but any role with table ownership or ALTER
 * privilege can bypass row triggers via ALTER TABLE … DISABLE TRIGGER. The
 * fix runs migrations as the owner role (`campusos`) and routes runtime
 * traffic through a non-owner DML role (`campusos_app` by default, override
 * via `DATABASE_APP_ROLE`) that holds only SELECT + INSERT on the immutable
 * tables — UPDATE/DELETE/TRUNCATE are explicitly REVOKEd. Combined with the
 * triggers this is defence-in-depth: the role check stops bulk DML even if
 * the trigger is somehow disabled, and the trigger catches per-row writes
 * if the role check is relaxed.
 */
export var IMMUTABLE_TABLES = [
  'dpo_pseudonymisation_log',
  'fds_inventory_transactions',
  'fin_gl_entries',
  'hlth_health_access_log',
  'inc_incident_timeline',
  'pay_credit_notes',
  'pay_ledger_entries',
  'pay_lunch_account_balance_transfers',
  'pay_payment_reversals',
  'pub_publication_versions',
  'svc_referral_activity',
  'tkt_ticket_activity',
];

function escapeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('Invalid SQL identifier: ' + name);
  }
  return '"' + name + '"';
}

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

  await applyImmutableRevokes(schemaName);

  console.log('   Tenant ' + schemaName + ' provisioned successfully');
  return schemaName;
}

/**
 * P2-H5 DEFECT 2: create the non-owner DML role (idempotent) and lock down
 * the 12 IMMUTABLE tables so the app role can SELECT + INSERT but cannot
 * UPDATE, DELETE, or TRUNCATE. Also REVOKEs the same operations from PUBLIC
 * as belt-and-braces against any role inheriting through PUBLIC.
 *
 * In dev/test the app may still connect as `campusos` (which is the owner
 * and bypasses these grants). The CI test in
 * `apps/api/src/__tests__/immutable-role-contract.spec.ts` reconnects as
 * `campusos_app` and asserts every immutable table refuses UPDATE/DELETE
 * AND that ALTER TABLE … DISABLE TRIGGER fails with permission denied.
 */
async function applyImmutableRevokes(schemaName: string): Promise<void> {
  var appRole = process.env.DATABASE_APP_ROLE || 'campusos_app';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) {
    throw new Error('Invalid DATABASE_APP_ROLE: ' + appRole);
  }
  // Idempotent role creation. DO block lives in a single statement so the
  // SQL splitter never sees the semicolons inside.
  await executePlatformSQL(
    "DO $body$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '" +
      appRole +
      "') THEN CREATE ROLE " +
      appRole +
      ' NOLOGIN; END IF; END $body$',
  );
  // Allow USAGE on the schema + baseline DML on every existing table.
  var schemaIdent = escapeIdent(schemaName);
  await executePlatformSQL('GRANT USAGE ON SCHEMA ' + schemaIdent + ' TO ' + appRole);
  await executePlatformSQL(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ' +
      schemaIdent +
      ' TO ' +
      appRole,
  );
  await executePlatformSQL(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ' + schemaIdent + ' TO ' + appRole,
  );
  // Lock down each IMMUTABLE table. UPDATE/DELETE/TRUNCATE are revoked from
  // both the app role and from PUBLIC (PUBLIC is the default role any role
  // inherits from). The triggers from migration 177 are defence-in-depth; the
  // REVOKE here is the load-bearing rule because a role without UPDATE
  // privilege cannot DISABLE TRIGGER either.
  for (var i = 0; i < IMMUTABLE_TABLES.length; i++) {
    var table = IMMUTABLE_TABLES[i];
    if (!table || !/^[a-z_][a-z0-9_]*$/.test(table)) {
      throw new Error('Invalid IMMUTABLE_TABLES entry: ' + table);
    }
    var qualified = schemaIdent + '.' + escapeIdent(table);
    await executePlatformSQL(
      'REVOKE UPDATE, DELETE, TRUNCATE ON ' + qualified + ' FROM ' + appRole,
    );
    await executePlatformSQL('REVOKE UPDATE, DELETE, TRUNCATE ON ' + qualified + ' FROM PUBLIC');
  }
  console.log(
    '   Immutable lockdown applied (' +
      IMMUTABLE_TABLES.length +
      ' tables, app role=' +
      appRole +
      ')',
  );
}

export { applyImmutableRevokes };

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
