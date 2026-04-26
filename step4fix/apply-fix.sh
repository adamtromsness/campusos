#!/bin/bash
# Run from ~/projects/campusos
set -e

echo "  Applying Step 4 fixes..."

# Copy fixed files
cp step4fix/client.ts packages/database/src/client.ts
cp step4fix/seed.ts packages/database/src/seed.ts
cp step4fix/provision-tenant.ts packages/database/src/provision-tenant.ts

# Install dotenv
pnpm --filter @campusos/database add dotenv 2>&1 | tail -1

# Build
echo "  Building..."
pnpm --filter @campusos/database build

# Provision tenant_demo
echo "  Provisioning tenant_demo..."
cd packages/database
npx tsx src/provision-tenant.ts --subdomain=demo
cd ../..

# Provision tenant_test
echo "  Provisioning tenant_test..."
cd packages/database
npx tsx src/provision-tenant.ts --subdomain=test
cd ../..

# Check results
echo ""
echo "  Checking tables..."
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('platform','tenant_demo','tenant_test') AND table_type='BASE TABLE' ORDER BY table_schema, table_name;"

echo ""
echo "  Done!"
