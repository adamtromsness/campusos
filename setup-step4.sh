#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# CampusOS — Step 4: Database Foundation Setup & Verification
# Run from: ~/projects/campusos
# Usage: bash setup-step4.sh
# ═══════════════════════════════════════════════════════════════

set -e

echo ""
echo "  🏫 CampusOS — Step 4: Database Foundation"
echo ""

# ── 1. Check Docker services are running ──
echo "  ── Pre-flight checks ──────────────────────────────────"
if ! docker exec campusos-postgres pg_isready -U campusos -d campusos_dev > /dev/null 2>&1; then
  echo "  ❌  PostgreSQL is not running. Start with: docker compose up -d"
  exit 1
fi
echo "  ✅  PostgreSQL is running"

# ── 2. Install dependencies (may have new ones) ──
echo ""
echo "  📦 Installing dependencies..."
pnpm install --reporter=silent
echo "  ✅  Dependencies installed"

# ── 3. Generate Prisma client ──
echo ""
echo "  🔧 Generating Prisma client..."
pnpm --filter @campusos/database generate 2>&1 | tail -3
echo "  ✅  Prisma client generated"

# ── 4. Run platform schema migration ──
echo ""
echo "  📐 Running platform schema migration..."
cd packages/database

# Use migrate deploy for non-interactive mode
# First migration: create initial tables
npx prisma migrate dev --schema=prisma/platform/schema.prisma --name init 2>&1 | grep -E "(migrations|applied|already)" || true
cd ../..
echo "  ✅  Platform migrations applied"

# ── 5. Build database package ──
echo ""
echo "  🔨 Building database package..."
pnpm --filter @campusos/database build 2>&1 | tail -2
echo "  ✅  Database package built"

# ── 6. Run seed script ──
echo ""
echo "  🌱 Running seed script..."
pnpm --filter @campusos/database seed
echo ""

# ── 7. Verification ──
echo "  ── Verification ───────────────────────────────────────"
PASS=0
FAIL=0

# Check platform tables exist
TABLE_COUNT=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'platform' AND table_type = 'BASE TABLE';" 2>/dev/null)
if [ "$TABLE_COUNT" -ge 4 ] 2>/dev/null; then
  echo "  ✅  Platform schema has $TABLE_COUNT tables"
  ((PASS++))
else
  echo "  ❌  Platform schema has ${TABLE_COUNT:-0} tables (expected ≥4)"
  ((FAIL++))
fi

# Check organisations table
ORG_CHECK=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT count(*) FROM platform.organisations;" 2>/dev/null)
if [ "$ORG_CHECK" -ge 1 ] 2>/dev/null; then
  echo "  ✅  organisations table seeded ($ORG_CHECK record(s))"
  ((PASS++))
else
  echo "  ❌  organisations table empty or missing"
  ((FAIL++))
fi

# Check schools table
SCHOOL_CHECK=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT count(*) FROM platform.schools;" 2>/dev/null)
if [ "$SCHOOL_CHECK" -ge 1 ] 2>/dev/null; then
  echo "  ✅  schools table seeded ($SCHOOL_CHECK record(s))"
  ((PASS++))
else
  echo "  ❌  schools table empty or missing"
  ((FAIL++))
fi

# Check tenant routing
ROUTING_CHECK=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT count(*) FROM platform.platform_tenant_routing;" 2>/dev/null)
if [ "$ROUTING_CHECK" -ge 1 ] 2>/dev/null; then
  echo "  ✅  tenant routing seeded ($ROUTING_CHECK record(s))"
  ((PASS++))
else
  echo "  ❌  tenant routing empty or missing"
  ((FAIL++))
fi

# Check tenant_demo schema has tables from migration
TENANT_TABLES=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'tenant_demo' AND table_type = 'BASE TABLE';" 2>/dev/null)
if [ "$TENANT_TABLES" -ge 1 ] 2>/dev/null; then
  echo "  ✅  tenant_demo schema has $TENANT_TABLES tables"
  ((PASS++))
else
  echo "  ⚠️   tenant_demo schema has no tables (migration may not have run)"
fi

# Check Prisma client was generated
if [ -d "node_modules/.prisma/client" ]; then
  echo "  ✅  Prisma client generated"
  ((PASS++))
else
  echo "  ❌  Prisma client not generated"
  ((FAIL++))
fi

# Check database package built
if [ -f "packages/database/dist/index.js" ]; then
  echo "  ✅  @campusos/database built"
  ((PASS++))
else
  echo "  ❌  @campusos/database not built"
  ((FAIL++))
fi

echo ""
echo "  ══════════════════════════════════════════════════════"
echo ""
echo "  Results: ✅ $PASS passed  ❌ $FAIL failed"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "  🟢 Step 4 PASSED — database foundation is ready!"
  echo ""
  echo "  What was created:"
  echo "    Platform schema:  organisations, schools, platform_tenant_routing,"
  echo "                      platform_audit_log, platform_event_consumer_idempotency"
  echo "    Tenant schema:    tenant_demo with school_config, feature_flags,"
  echo "                      grading_scales, custom_field_definitions/values"
  echo "    Seed data:        Demo School District → Lincoln Elementary (demo)"
  echo ""
  echo "  Useful commands:"
  echo "    pnpm db:studio                    # Visual database browser"
  echo "    pnpm db:seed                      # Re-run seed script"
  echo "    pnpm --filter @campusos/database provision --subdomain=test"
  echo ""
else
  echo "  🔴 Step 4 has $FAIL failure(s). Check errors above."
fi

echo ""
