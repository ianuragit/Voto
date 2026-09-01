#!/usr/bin/env node
/**
 * §7.4 — the air gap, enforced.
 *
 * Two rules, both hard failures:
 *
 *   1. No module may import both `db/auth.ts` and `db/tally.ts`. If one module
 *      ever holds both connections, a JOIN becomes expressible and the whole
 *      privacy story collapses to "we promise we won't".
 *   2. Only `repos/authRepo.ts` may import `db/auth.ts`, and only
 *      `repos/tallyRepo.ts` may import `db/tally.ts`. Everything else goes
 *      through the repository interfaces.
 *
 * Run in CI. A violation here is not a style problem.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

const AUTH_DB = /['"][^'"]*db\/auth(\.js)?['"]/;
const TALLY_DB = /['"][^'"]*db\/tally(\.js)?['"]/;
const IMPORT_LINE = /^\s*(?:import|export)\b[^;]*?from\s*(['"][^'"]+['"])/gm;

const ALLOWED_AUTH_IMPORTERS = new Set(['src/repos/authRepo.ts']);
const ALLOWED_TALLY_IMPORTERS = new Set(['src/repos/tallyRepo.ts']);
const SELF = new Set(['src/db/auth.ts', 'src/db/tally.ts']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations = [];

for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (SELF.has(rel)) continue;

  const source = readFileSync(file, 'utf8');
  const specifiers = [...source.matchAll(IMPORT_LINE)].map((m) => m[1]);

  const importsAuth = specifiers.some((s) => AUTH_DB.test(s));
  const importsTally = specifiers.some((s) => TALLY_DB.test(s));

  if (importsAuth && importsTally) {
    violations.push(`${rel}: imports BOTH database connections. The air gap (§7.4) forbids this.`);
  }
  if (importsAuth && !ALLOWED_AUTH_IMPORTERS.has(rel)) {
    violations.push(`${rel}: imports db/auth directly. Use repos/authRepo.ts.`);
  }
  if (importsTally && !ALLOWED_TALLY_IMPORTERS.has(rel)) {
    violations.push(`${rel}: imports db/tally directly. Use repos/tallyRepo.ts.`);
  }
}

// The tally store's schema is part of the guarantee: three columns, nothing else.
const tallySource = readFileSync(path.join(SRC, 'db/tally.ts'), 'utf8');
const createTable = tallySource.match(/CREATE TABLE IF NOT EXISTS tallies\s*\(([\s\S]*?)\)\s*WITHOUT ROWID/i);
if (!createTable) {
  violations.push('src/db/tally.ts: could not find the tallies table definition.');
} else {
  const columns = createTable[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(PRIMARY KEY|--)/i.test(line))
    .map((line) => line.split(/\s+/)[0].toLowerCase());
  const expected = ['poll_id', 'option_index', 'count'];
  if (columns.join(',') !== expected.join(',')) {
    violations.push(
      `src/db/tally.ts: tallies must have exactly [${expected.join(', ')}]; found [${columns.join(', ')}].`,
    );
  }
}

if (violations.length > 0) {
  console.error('Air-gap check FAILED:\n');
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error('');
  process.exit(1);
}

console.log('Air-gap check passed: no module holds both connections; tally schema is (poll_id, option_index, count).');
