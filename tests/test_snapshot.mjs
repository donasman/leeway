// Run with: node tests/test_snapshot.mjs
import { toSnapshot, snapshotWrites, primaryLimitId, usageKey, lastOkKey } from '../extension/snapshot.js';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;

function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  const tag = ok ? PASS : FAIL;
  console.log(`  [${tag}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

const NOW = Date.UTC(2026, 9, 15, 4, 12, 0); // 2026-10-15T04:12:00.000Z
const limit = (id, remaining_percent, extra = {}) => ({id, label: id, remaining_percent, resets_at: null, reset_text: null, ...extra});
const payload = (extra = {}) => ({
  provider: 'chatgpt', value: '61%', detail: '5-hour limit: 61% remaining', status: 'ok',
  limits: [limit('chatgpt_5h', 61), limit('chatgpt_weekly', 60)],
  ...extra,
});
const ids = snapshot => snapshot.limits.map(l => l.id);
const pct = (snapshot, id) => snapshot.limits.find(l => l.id === id)?.remaining_percent;

// ---------------------------------------------------------------------------
console.log('\ntoSnapshot — shape');
{
  const s = toSnapshot(payload(), NOW);
  check('provider', s.provider, 'chatgpt');
  check('status', s.status, 'ok');
  check('collected_at is UTC ISO', s.collected_at, '2026-10-15T04:12:00.000Z');
  check('primary_limit_id', s.primary_limit_id, 'chatgpt_5h');
  check('limits', ids(s), ['chatgpt_5h', 'chatgpt_weekly']);
  check('detail kept', s.detail, '5-hour limit: 61% remaining');
  check('legacy value not stored', 'value' in s, false);
  check('keys', Object.keys(s), ['provider', 'status', 'collected_at', 'primary_limit_id', 'limits', 'detail']);
  check('provider is lower-cased', toSnapshot(payload({provider: 'ChatGPT'}), NOW)?.provider, 'chatgpt');
  check('unknown provider → null', toSnapshot(payload({provider: 'perplexity'}), NOW), null);
  check('missing provider → null', toSnapshot({status: 'ok'}, NOW), null);
  check('null payload → null', toSnapshot(null, NOW), null);
}
{
  const input = payload();
  const before = JSON.stringify(input);
  toSnapshot(input, NOW);
  check('input not mutated', JSON.stringify(input), before);
}

// ---------------------------------------------------------------------------
console.log('\nremaining_percent — 0 and null stay apart (CLAUDE.md §1)');
{
  const s = toSnapshot(payload({limits: [limit('chatgpt_5h', 0)]}), NOW);
  check('0 stays 0', pct(s, 'chatgpt_5h'), 0);
  check('0 is a readable primary — still ok', s.status, 'ok');
}
{
  const s = toSnapshot(payload({limits: [{id: 'chatgpt_5h', label: '5h'}]}), NOW);
  check('missing field → null', pct(s, 'chatgpt_5h'), null);
}
{
  const bad = ['61', '', NaN, Infinity, true, {}];
  const s = toSnapshot(payload({limits: bad.map((v, i) => limit(`chatgpt_bad${i}`, v)).concat(limit('chatgpt_5h', 61))}), NOW);
  check("non-numbers → null, never coerced ('' would be 0)", s.limits.map(l => l.remaining_percent), [null, null, null, null, null, null, 61]);
}
{
  const s = toSnapshot(payload({limits: [limit('chatgpt_5h', 150), limit('chatgpt_weekly', -5), limit('chatgpt_x', 42.5)]}), NOW);
  check('150 → 100', pct(s, 'chatgpt_5h'), 100);
  check('-5 → 0', pct(s, 'chatgpt_weekly'), 0);
  check('fraction kept', pct(s, 'chatgpt_x'), 42.5);
}

// ---------------------------------------------------------------------------
console.log('\nprimary value (CLAUDE.md §1) — "ok" needs a readable primary');
{
  const s = toSnapshot(payload({limits: [limit('chatgpt_5h', null), limit('chatgpt_weekly', 60)]}), NOW);
  check('unreadable 5h + weekly: not ok', s.status, 'parse_failed');
  check('…weekly NOT promoted to primary', s.primary_limit_id, null);
  check('…reason', s.detail, 'ok payload, but chatgpt_5h has no value');
  check('…both limits kept for display', s.limits.map(l => [l.id, l.remaining_percent]), [['chatgpt_5h', null], ['chatgpt_weekly', 60]]);
}
{
  const s = toSnapshot(payload({limits: [limit('chatgpt_5h', '61'), limit('chatgpt_weekly', 60)]}), NOW);
  check('malformed 5h value: entry kept as null, not dropped', pct(s, 'chatgpt_5h'), null);
  check('…so weekly is not promoted', [s.status, s.primary_limit_id], ['parse_failed', null]);
}
{
  const s = toSnapshot(payload({limits: [limit('chatgpt_weekly', 60)]}), NOW);
  check('ok without any 5h entry (no 5h limit, e.g. Pro) → weekly', [s.status, s.primary_limit_id], ['ok', 'chatgpt_weekly']);
}
{
  const s = toSnapshot(payload({status: 'parse_failed', limits: [limit('chatgpt_weekly', 60)]}), NOW);
  check('failed read without 5h entry proves nothing → no primary', [s.status, s.primary_limit_id], ['parse_failed', null]);
  check('…weekly still kept for display', pct(s, 'chatgpt_weekly'), 60);
}
{
  const s = toSnapshot(payload({limits: [limit('chatgpt_monthly', 80)]}), NOW);
  check('ok with neither 5h nor weekly → first limit', s.primary_limit_id, 'chatgpt_monthly');
}

// ---------------------------------------------------------------------------
console.log('\nstatus');
{
  check('unknown status → parse_failed', toSnapshot(payload({status: 'great'}), NOW).status, 'parse_failed');
  check('missing status → parse_failed', toSnapshot(payload({status: undefined}), NOW).status, 'parse_failed');
  for (const status of ['logged_out', 'parse_failed', 'needs_permission', 'disabled']) {
    const s = toSnapshot(payload({status, limits: []}), NOW);
    check(`${status} kept, no primary`, [s.status, s.primary_limit_id], [status, null]);
  }
  const empty = toSnapshot(payload({limits: []}), NOW);
  check('ok without limits → parse_failed', empty.status, 'parse_failed');
  check('…with a reason', empty.detail, 'ok payload without a readable limit');
  const nulls = toSnapshot(payload({limits: [limit('chatgpt_5h', null)]}), NOW);
  check('ok with only null limits → parse_failed', nulls.status, 'parse_failed');
}

// ---------------------------------------------------------------------------
console.log('\nlimits — contract checks');
{
  const s = toSnapshot(payload({limits: [limit('claude_5h', 10), limit('chatgpt_5h', 61), limit('chatgpt_5h', 1)]}), NOW);
  check('other provider ids dropped, first duplicate wins', s.limits.map(l => [l.id, l.remaining_percent]), [['chatgpt_5h', 61]]);
  const many = toSnapshot(payload({limits: Array.from({length: 12}, (_, i) => limit(`chatgpt_m${i}`, i))}), NOW);
  check('at most 8 limits', many.limits.length, 8);
  check('limits not an array → []', toSnapshot(payload({status: 'parse_failed', limits: 'x'}), NOW).limits, []);
  const long = toSnapshot(payload({
    detail: 'd'.repeat(300),
    limits: [limit('chatgpt_5h', 61, {label: 'l'.repeat(50), reset_text: 'r'.repeat(100)})],
  }), NOW);
  check('label ≤ 40', long.limits[0].label.length, 40);
  check('reset_text ≤ 80', long.limits[0].reset_text.length, 80);
  check('detail ≤ 200', long.detail.length, 200);
  check('missing label → id', toSnapshot(payload({limits: [{id: 'chatgpt_5h', remaining_percent: 61}]}), NOW).limits[0].label, 'chatgpt_5h');
}

// ---------------------------------------------------------------------------
console.log('\ndetail — URLs keep only their origin (CLAUDE.md §3)');
{
  const d = text => toSnapshot(payload({status: 'parse_failed', limits: [], detail: text}), NOW).detail;
  check('conversation URL', d('ChatGPT Usage UI unavailable: https://chatgpt.com/c/68e1-abcd: Could not establish connection.'),
    'ChatGPT Usage UI unavailable: https://chatgpt.com: Could not establish connection.');
  check('hash route', d('tab https://chatgpt.com/#settings/Usage gone'), 'tab https://chatgpt.com gone');
  check('port kept', d('POST http://127.0.0.1:8765/usage failed'), 'POST http://127.0.0.1:8765 failed');
  check('bare origin unchanged', d('see https://chatgpt.com'), 'see https://chatgpt.com');
  check('no URL unchanged', d('Claude usage unavailable: http-500'), 'Claude usage unavailable: http-500');
}

// ---------------------------------------------------------------------------
console.log('\nresets_at — ISO with a zone, normalized to UTC');
{
  const at = value => toSnapshot(payload({limits: [limit('chatgpt_5h', 61, {resets_at: value})]}), NOW).limits[0].resets_at;
  check('Z', at('2026-10-15T09:00:00Z'), '2026-10-15T09:00:00.000Z');
  check('microseconds + offset', at('2026-10-15T09:00:00.123456+00:00'), '2026-10-15T09:00:00.123Z');
  check('+09:00 → UTC', at('2026-10-15T18:00:00+09:00'), '2026-10-15T09:00:00.000Z');
  check('zone-less → null (would be read as local time)', at('2026-10-15 09:00:00'), null);
  check('garbage → null', at('soon'), null);
  check('number → null', at(1760518800), null);
}

// ---------------------------------------------------------------------------
console.log('\nprimaryLimitId — preference order');
{
  const L = (...pairs) => pairs.map(([id, v]) => limit(id, v));
  check('5h when present', primaryLimitId('chatgpt', L(['chatgpt_weekly', 60], ['chatgpt_5h', 61])), 'chatgpt_5h');
  check('unknown 5h still wins', primaryLimitId('chatgpt', L(['chatgpt_5h', null], ['chatgpt_weekly', 60])), 'chatgpt_5h');
  check('no 5h entry → weekly', primaryLimitId('chatgpt', L(['chatgpt_weekly', 60])), 'chatgpt_weekly');
  check('neither → first', primaryLimitId('chatgpt', L(['chatgpt_monthly', 80])), 'chatgpt_monthly');
  check('none → null', primaryLimitId('chatgpt', []), null);
  check('per provider', primaryLimitId('claude', L(['claude_weekly', 3], ['claude_5h', 0])), 'claude_5h');
}

// ---------------------------------------------------------------------------
console.log('\nsnapshotWrites — usage_<p> and usage_last_ok_<p>');
{
  check('keys', [usageKey('gemini'), lastOkKey('gemini')], ['usage_gemini', 'usage_last_ok_gemini']);
  const ok = snapshotWrites(payload(), NOW);
  check('ok writes both', Object.keys(ok), ['usage_chatgpt', 'usage_last_ok_chatgpt']);
  check('…same snapshot', ok.usage_last_ok_chatgpt, ok.usage_chatgpt);
  for (const status of ['parse_failed', 'logged_out']) {
    const w = snapshotWrites(payload({status, limits: []}), NOW);
    check(`${status} keeps last ok (key absent)`, Object.keys(w), ['usage_chatgpt']);
  }
  for (const status of ['needs_permission', 'disabled']) {
    const w = snapshotWrites(payload({status, limits: []}), NOW);
    check(`${status} clears last ok`, w.usage_last_ok_chatgpt, null);
  }
  const downgraded = snapshotWrites(payload({limits: [limit('chatgpt_5h', null), limit('chatgpt_weekly', 60)]}), NOW);
  check('ok with unreadable primary keeps last ok', Object.keys(downgraded), ['usage_chatgpt']);
  check('unknown provider → null', snapshotWrites(payload({provider: 'x'}), NOW), null);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
