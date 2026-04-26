#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# CampusOS — Step 2: Initialize Monorepo
# Run this ONCE after extracting the scaffold into ~/projects/campusos
# Usage: cd ~/projects/campusos && bash setup.sh
# ═══════════════════════════════════════════════════════════════

set -e

echo ""
echo "  🏫 CampusOS — Initializing Monorepo"
echo ""

# ── 1. Copy environment file ──
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "  ✅  Created .env.local from .env.example"
else
  echo "  ⏭️   .env.local already exists, skipping"
fi

# ── 2. Initialize Git repo ──
if [ ! -d .git ]; then
  git init
  git add .
  git commit -m "chore: scaffold monorepo — Cycle 0, Step 2

  pnpm + Turborepo monorepo with:
  - apps/api (NestJS 10, TypeScript strict)
  - apps/web (Next.js 14, Tailwind CSS)
  - packages/database (Prisma, PostgreSQL)
  - packages/shared (types, constants)
  - packages/eslint-config (shared rules)
  - packages/tsconfig (shared TS configs)

  CampusOS Platform Foundation — Wave 1, Cycle 0"
  echo "  ✅  Git repository initialized with initial commit"
else
  echo "  ⏭️   Git repo already exists, skipping"
fi

# ── 3. Install dependencies ──
echo ""
echo "  📦 Installing dependencies (this may take a minute)..."
echo ""
pnpm install

echo ""
echo "  ✅  Dependencies installed"

# ── 4. Build shared packages ──
echo ""
echo "  🔨 Building shared packages..."
pnpm --filter @campusos/shared build
echo "  ✅  Shared packages built"

# ── 5. Verify ──
echo ""
echo "  🧪 Running verification..."
echo ""

PASS=0
FAIL=0

# Check pnpm install worked
if [ -d "node_modules" ]; then echo "  ✅  node_modules exists"; ((PASS++)); else echo "  ❌  node_modules missing"; ((FAIL++)); fi

# Check turbo is available
if pnpm turbo --version > /dev/null 2>&1; then echo "  ✅  turbo available"; ((PASS++)); else echo "  ❌  turbo not found"; ((FAIL++)); fi

# Check NestJS CLI is available
if pnpm --filter @campusos/api exec nest --version > /dev/null 2>&1; then echo "  ✅  nest CLI available"; ((PASS++)); else echo "  ❌  nest CLI not found"; ((FAIL++)); fi

# Check Next.js is available
if pnpm --filter @campusos/web exec next --version > /dev/null 2>&1; then echo "  ✅  next CLI available"; ((PASS++)); else echo "  ❌  next CLI not found"; ((FAIL++)); fi

# Check shared package built
if [ -f "packages/shared/dist/index.js" ]; then echo "  ✅  @campusos/shared built"; ((PASS++)); else echo "  ❌  @campusos/shared not built"; ((FAIL++)); fi

echo ""
echo "  Results: ✅ $PASS passed  ❌ $FAIL failed"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "  🟢 Step 2 PASSED — monorepo is ready!"
  echo ""
  echo "  Next commands to try:"
  echo "    pnpm dev          # Start API (4000) + Web (3000)"
  echo "    pnpm build        # Build all apps"
  echo "    pnpm test         # Run tests"
  echo "    pnpm lint         # Lint all code"
  echo ""
else
  echo "  🔴 Step 2 has $FAIL failure(s). Check errors above."
fi
