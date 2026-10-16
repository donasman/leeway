// Run with: node tests/test_parsers.mjs
import { clampPct, fmtReset, pickClaudeBuckets } from '../extension/parsers.js';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;

function eq(a, b) {
  if (a === b) return true;
  if (a === null && b === null) return true;
  if (a === undefined && b === undefined) return true;
  return false;
}

function check(label, got, expected) {
  const ok = eq(got, expected);
  const tag = ok ? PASS : FAIL;
  console.log(`  [${tag}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// clampPct — 9 cases
// ---------------------------------------------------------------------------
console.log('\nclampPct');
check('0 → 0',           clampPct(0),         0);
check("'0' → 0",         clampPct('0'),        0);
check('50 → 50',         clampPct(50),         50);
check('null → null',     clampPct(null),       null);
check('undefined → null',clampPct(undefined),  null);
check("'' → null",       clampPct(''),         null);
check("'abc' → null",    clampPct('abc'),      null);
check('150 → 100',       clampPct(150),        100);
check('-5 → 0',          clampPct(-5),         0);

// ---------------------------------------------------------------------------
// fmtReset — basic smoke tests
// ---------------------------------------------------------------------------
console.log('\nfmtReset');
check('null → empty',    fmtReset(null),       '');
check('empty → empty',   fmtReset(''),         '');
check('invalid → empty', fmtReset('not-a-date'),'');
{
  const iso = '2026-09-10T12:00:00Z';
  const result = fmtReset(iso);
  const ok = typeof result === 'string' && result.length > 0;
  const tag = ok ? PASS : FAIL;
  console.log(`  [${tag}] valid ISO → non-empty string: got ${JSON.stringify(result)}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// pickClaudeBuckets — basic structure tests
// ---------------------------------------------------------------------------
console.log('\npickClaudeBuckets');
{
  const r = pickClaudeBuckets(null);
  check('null → {session:null,weekly:null}', r.session === null && r.weekly === null, true);
}
{
  const r = pickClaudeBuckets({limits:[
    {kind:'session',    percent:40, resets_at:'2026-09-10T12:00:00Z'},
    {kind:'weekly_all', percent:20, resets_at:'2026-09-14T00:00:00Z'},
  ]});
  check('session utilization', r.session?.utilization, 40);
  check('weekly utilization',  r.weekly?.utilization,  20);
}
{
  const r = pickClaudeBuckets({five_hour:{utilization:30}, seven_day:{utilization:60}});
  check('fallback five_hour',  r.session?.utilization, 30);
  check('fallback seven_day',  r.weekly?.utilization,  60);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
