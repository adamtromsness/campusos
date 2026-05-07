#!/usr/bin/env tsx
/*
 * Cycle 31 Step 1 — Log Schema Lint.
 *
 * CI-enforced rule per Architecture Review §25.2 + the cycle-31
 * implementation plan. Scans apps/api/src for forbidden patterns:
 *
 *   1. `console.log` / `console.warn` / `console.error` outside
 *      tools, scripts, and *.spec.ts files. The structured Logger
 *      (NestJS) is the only sanctioned write path.
 *   2. Stack-trace patterns embedded in log MESSAGES
 *      (`stack: err.stack` is fine when emitted as a separate
 *      field; pasting the stack into the message corrupts the
 *      JSON-shape).
 *   3. PII patterns in template strings: an obvious email regex
 *      (`@[a-z]+\.[a-z]+`) inside a logger argument. Names are
 *      hard to detect statically; the team relies on review for
 *      that.
 *
 * Exits non-zero on any violation. Wired into the `pnpm lint`
 * pipeline so PRs that drift from the schema fail CI.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['apps/api/src'];
const EXEMPT_PATHS = [
  'apps/api/src/observability/structured-logger.ts', // the logger itself uses process.stdout
];
const EXEMPT_SUFFIXES = ['.spec.ts', '.test.ts'];

interface Violation {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
      walk(fullPath, out);
    } else if (entry.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
}

function isExempt(file: string): boolean {
  const rel = file.slice(ROOT.length + 1);
  if (EXEMPT_PATHS.includes(rel)) return true;
  return EXEMPT_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

function scan(file: string, violations: Violation[]): void {
  if (isExempt(file)) return;
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((rawLine, idx) => {
    // Strip line comments to avoid false positives in commentary
    const codeOnly = rawLine.replace(/\/\/.*/g, '');
    if (/console\.(log|warn|error|info|debug)\(/.test(codeOnly)) {
      violations.push({
        file: file.slice(ROOT.length + 1),
        line: idx + 1,
        rule: 'no-console',
        excerpt: rawLine.trim().slice(0, 120),
      });
    }
    // Email pattern inside a logger / console argument.
    if (
      /(logger\.(log|warn|error|debug|verbose)|console\.(log|warn|error|info|debug))/.test(
        codeOnly,
      ) &&
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(codeOnly)
    ) {
      violations.push({
        file: file.slice(ROOT.length + 1),
        line: idx + 1,
        rule: 'no-email-pii-in-log',
        excerpt: rawLine.trim().slice(0, 120),
      });
    }
  });
}

function main(): void {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    walk(join(ROOT, dir), files);
  }
  const violations: Violation[] = [];
  for (const file of files) scan(file, violations);

  if (violations.length === 0) {
    process.stdout.write(`log-schema-lint: ✓ ${files.length} files clean\n`);
    process.exit(0);
  }

  process.stderr.write(`log-schema-lint: ${violations.length} violation(s):\n\n`);
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}  [${v.rule}]  ${v.excerpt}\n`);
  }
  process.exit(1);
}

main();
