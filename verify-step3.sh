#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# CampusOS — Step 3 Verification
# Run after: docker compose up -d
# Usage: bash verify-step3.sh
# ═══════════════════════════════════════════════════════════════

PASS=0
FAIL=0

echo ""
echo "  CampusOS — Step 3: Local Services Verification"
echo ""

# ── Docker Compose ──
echo "  ── Docker Compose ───────────────────────────────────"
RUNNING=$(docker compose ps --format json 2>/dev/null | grep -c '"running"' 2>/dev/null || echo "0")
SERVICES=$(docker compose ps --services 2>/dev/null | wc -l)
echo "  ℹ️   $RUNNING of $SERVICES services running"

# ── PostgreSQL ──
echo ""
echo "  ── PostgreSQL ─────────────────────────────────────────"
if docker exec campusos-postgres pg_isready -U campusos -d campusos_dev > /dev/null 2>&1; then
  echo "  ✅  PostgreSQL is ready"
  ((PASS++))
else
  echo "  ❌  PostgreSQL is not ready"
  ((FAIL++))
fi

# Check platform schema exists
SCHEMA_CHECK=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'platform';" 2>/dev/null)
if [ "$SCHEMA_CHECK" = "platform" ]; then
  echo "  ✅  platform schema exists"
  ((PASS++))
else
  echo "  ❌  platform schema missing"
  ((FAIL++))
fi

# Check tenant_demo schema exists
TENANT_CHECK=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'tenant_demo';" 2>/dev/null)
if [ "$TENANT_CHECK" = "tenant_demo" ]; then
  echo "  ✅  tenant_demo schema exists"
  ((PASS++))
else
  echo "  ❌  tenant_demo schema missing"
  ((FAIL++))
fi

# Check extensions
EXT_CHECK=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc "SELECT count(*) FROM pg_extension WHERE extname IN ('uuid-ossp', 'pgcrypto');" 2>/dev/null)
if [ "$EXT_CHECK" -ge 2 ] 2>/dev/null; then
  echo "  ✅  Extensions installed (uuid-ossp, pgcrypto)"
  ((PASS++))
else
  echo "  ❌  Extensions missing"
  ((FAIL++))
fi

# ── Redis ──
echo ""
echo "  ── Redis ──────────────────────────────────────────────"
REDIS_PING=$(docker exec campusos-redis redis-cli ping 2>/dev/null)
if [ "$REDIS_PING" = "PONG" ]; then
  echo "  ✅  Redis is ready — PONG"
  ((PASS++))
else
  echo "  ❌  Redis is not ready"
  ((FAIL++))
fi

# ── Kafka ──
echo ""
echo "  ── Kafka ──────────────────────────────────────────────"
if docker exec campusos-kafka if docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list > /dev/null 2>&1; thenkafka-broker-api-versions.sh --bootstrap-server localhost:9092 > /dev/null 2>&1; then
  echo "  ✅  Kafka broker is ready"
  ((PASS++))
else
  echo "  ❌  Kafka broker is not ready (may still be starting — wait 30s and retry)"
  ((FAIL++))
fi

# ── Keycloak ──
echo ""
echo "  ── Keycloak ───────────────────────────────────────────"
KC_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health/ready 2>/dev/null)
if [ "$KC_STATUS" = "200" ]; then
  echo "  ✅  Keycloak is ready"
  ((PASS++))
else
  echo "  ❌  Keycloak is not ready (status: $KC_STATUS — may need 30-60s to start)"
  ((FAIL++))
fi

# Check realm was imported
KC_REALM=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/realms/campusos 2>/dev/null)
if [ "$KC_REALM" = "200" ]; then
  echo "  ✅  campusos realm imported"
  ((PASS++))
else
  echo "  ❌  campusos realm not found"
  ((FAIL++))
fi

# ── Connection strings ──
echo ""
echo "  ── Connection Strings (for .env.local) ────────────────"
echo "  DATABASE_URL=postgresql://campusos:campusos_dev@localhost:5432/campusos_dev?schema=platform"
echo "  REDIS_URL=redis://localhost:6379"
echo "  KAFKA_BROKERS=localhost:9092"
echo "  OIDC_ISSUER=http://localhost:8080/realms/campusos"

# ── Summary ──
echo ""
echo "  ══════════════════════════════════════════════════════"
echo ""
echo "  Results: ✅ $PASS passed  ❌ $FAIL failed"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "  🟢 Step 3 PASSED — all local services are running!"
  echo ""
  echo "  Services:"
  echo "    PostgreSQL  → localhost:5432  (user: campusos / pass: campusos_dev)"
  echo "    Redis       → localhost:6379"
  echo "    Kafka       → localhost:9092"
  echo "    Keycloak    → http://localhost:8080  (admin / admin)"
  echo "    Kafka UI    → docker compose --profile tools up -d kafka-ui → http://localhost:8081"
  echo ""
else
  echo "  🔴 Step 3 has $FAIL failure(s)."
  echo "     If services are still starting, wait 30-60s and re-run."
  echo "     Check logs: docker compose logs <service-name>"
fi

echo ""
