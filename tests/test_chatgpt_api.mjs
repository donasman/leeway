// Run with: node tests/test_chatgpt_api.mjs
//
// extension/chatgpt_api.js turns GET /backend-api/wham/usage into the collector
// payload. The bodies below follow the response structure seen in a logged-in
// Chrome on 2026-10-15 (field names and types only; the values are made up).
import { windowKind, whamLimits, whamPayload, whamWindows, whamPlan } from '../extension/chatgpt_api.js';
import { toSnapshot } from '../extension/snapshot.js';

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

const NOW = Date.UTC(2026, 9, 15, 4, 12, 0);
const HOUR = 3600;
const DAY = 24 * HOUR;
const RESET = NOW / 1000 + 4 * HOUR; // Unix seconds
const iso = seconds => new Date(seconds * 1000).toISOString();
const w = (seconds, used, extra = {}) => ({used_percent: used, limit_window_seconds: seconds, reset_after_seconds: 1800, reset_at: RESET, ...extra});
const body = (primary, secondary = null, extra = {}) => ({
  user_id: 'user-secret-1', account_id: 'account-secret-2', email: 'someone@example.com', plan_type: 'plus',
  rate_limit: {allowed: true, limit_reached: false, primary_window: primary, secondary_window: secondary},
  code_review_rate_limit: null, additional_rate_limits: null, model_usage: {},
  credits: {has_credits: false, unlimited: false, overage_limit_reached: false, balance: null},
  ...extra,
});
const ids = limits => limits.map(l => [l.id, l.remaining_percent]);

// ---------------------------------------------------------------------------
console.log('\nwindowKind — by length, not by name');
{
  check('5 hours', windowKind(5 * HOUR), {suffix: '5h', label: '5-hour limit'});
  check('7 days', windowKind(7 * DAY), {suffix: 'weekly', label: 'Weekly limit'});
  check('30 days (seen 2026-10-15)', windowKind(30 * DAY), {suffix: 'monthly', label: 'Monthly limit'});
  check('28 days is monthly too', windowKind(28 * DAY), {suffix: 'monthly', label: 'Monthly limit'});
  check('1 day: its own id', windowKind(DAY), {suffix: '86400s', label: '1-day limit'});
  check('2 hours: its own id', windowKind(2 * HOUR), {suffix: '7200s', label: '2-hour limit'});
  check('90 s', windowKind(90), {suffix: '90s', label: '2-minute limit'});
}

console.log('\nwhamLimits — used → remaining (CLAUDE.md §1)');
{
  check('Plus: 5-hour + weekly', ids(whamLimits(body(w(5 * HOUR, 39), w(7 * DAY, 60)), NOW)), [['chatgpt_5h', 61], ['chatgpt_weekly', 40]]);
  check('reset_at (Unix seconds) → ISO', whamLimits(body(w(5 * HOUR, 39)), NOW)[0].resets_at, iso(RESET));
  check('no reset_at → now + reset_after_seconds',
    whamLimits(body(w(5 * HOUR, 39, {reset_at: undefined})), NOW)[0].resets_at, new Date(NOW + 1800 * 1000).toISOString());
  check('neither → null', whamLimits(body(w(5 * HOUR, 39, {reset_at: null, reset_after_seconds: null})), NOW)[0].resets_at, null);
  const resetOf = extra => whamLimits(body(w(5 * HOUR, 39, extra)), NOW)[0].resets_at;
  check('reset_at in microseconds → null, no throw', resetOf({reset_at: 1e16}), null);
  check('reset_at in milliseconds → null, not a date in year 57000', resetOf({reset_at: RESET * 1000}), null);
  check('reset_at long past → null', resetOf({reset_at: RESET - 400 * DAY}), null);
  check('reset_after_seconds far off → null', resetOf({reset_at: undefined, reset_after_seconds: 1e12}), null);
  check('reset_text stays null (resets_at is exact)', whamLimits(body(w(5 * HOUR, 39)), NOW)[0].reset_text, null);
  check('Pro: primary_window is the weekly one', ids(whamLimits(body(w(7 * DAY, 25)), NOW)), [['chatgpt_weekly', 75]]);
  check('one 30-day window, secondary null (seen 2026-10-15)', ids(whamLimits(body(w(30 * DAY, 0)), NOW)), [['chatgpt_monthly', 100]]);
  check('order by length, whatever the field name', ids(whamLimits(body(w(7 * DAY, 60), w(5 * HOUR, 39)), NOW)), [['chatgpt_5h', 61], ['chatgpt_weekly', 40]]);
  check('used 100 → 0, not null', ids(whamLimits(body(w(5 * HOUR, 100)), NOW)), [['chatgpt_5h', 0]]);
  check('used over 100 → 0', ids(whamLimits(body(w(5 * HOUR, 130)), NOW)), [['chatgpt_5h', 0]]);
  check('used below 0 → 100', ids(whamLimits(body(w(5 * HOUR, -5)), NOW)), [['chatgpt_5h', 100]]);
  check('fractional used kept', ids(whamLimits(body(w(5 * HOUR, 12.5)), NOW)), [['chatgpt_5h', 87.5]]);
  check('used missing → listed with null', ids(whamLimits(body(w(5 * HOUR, undefined)), NOW)), [['chatgpt_5h', null]]);
  check('used as a string → null, not coerced', ids(whamLimits(body(w(5 * HOUR, '39')), NOW)), [['chatgpt_5h', null]]);
  check('window without a length: not listed (can\'t be placed)', ids(whamLimits(body(w(undefined, 39), w(7 * DAY, 60)), NOW)), [['chatgpt_weekly', 40]]);
  check('zero length → skipped', ids(whamLimits(body(w(0, 39)), NOW)), []);
  check('two windows of the same length → one', ids(whamLimits(body(w(5 * HOUR, 39), w(5 * HOUR, 50)), NOW)), [['chatgpt_5h', 61]]);
  check('no rate_limit', whamLimits({plan_type: 'free'}, NOW), []);
  check('null body', whamLimits(null, NOW), []);
  check('windows null', whamLimits(body(null, null), NOW), []);
  check('limit shape', Object.keys(whamLimits(body(w(5 * HOUR, 39)), NOW)[0]), ['id', 'label', 'remaining_percent', 'resets_at', 'reset_text']);
}

console.log('\nwhamPayload — the collector payload');
{
  const p = whamPayload(body(w(5 * HOUR, 39), w(7 * DAY, 60)), NOW);
  check('provider / status / value', [p.provider, p.status, p.value], ['chatgpt', 'ok', '61%']);
  check('detail lists every window', p.detail.split(' · ').map(part => part.split(':')[0]), ['5-hour limit', 'Weekly limit']);
  check('Pro: value is the weekly one', whamPayload(body(w(7 * DAY, 25)), NOW).value, '75%');
  check('30 days only: value is the monthly one', whamPayload(body(w(30 * DAY, 0)), NOW).value, '100%');
  check('0 left → "0%"', whamPayload(body(w(5 * HOUR, 100)), NOW).value, '0%');
  const unreadable = whamPayload(body(w(5 * HOUR, undefined), w(7 * DAY, 60)), NOW);
  check('5-hour used_percent unreadable → parse_failed, weekly not promoted',
    [unreadable.value, unreadable.status, unreadable.detail], ['?', 'parse_failed', 'wham/usage: 5-hour limit has no usable used_percent']);
  check('...readable limits kept for display', ids(unreadable.limits), [['chatgpt_5h', null], ['chatgpt_weekly', 40]]);
  const noLength = whamPayload(body(w(undefined, 39), w(7 * DAY, 60)), NOW);
  check('a window without a usable length → parse_failed (it might be the 5-hour one)',
    [noLength.status, noLength.detail, ids(noLength.limits)], ['parse_failed', 'wham/usage: a window has no usable limit_window_seconds', [['chatgpt_weekly', 40]]]);
  check('length as a string → parse_failed', whamPayload(body(w('18000', 39), w(7 * DAY, 60)), NOW).status, 'parse_failed');
  check('length null → parse_failed', whamPayload(body(w(null, 39), w(7 * DAY, 60)), NOW).status, 'parse_failed');
  check('a window that is not an object → parse_failed', whamPayload(body('5h', w(7 * DAY, 60)), NOW).status, 'parse_failed');
  check('no window → parse_failed', whamPayload(body(null, null), NOW), {provider: 'chatgpt', value: '?', detail: 'wham/usage: no rate_limit window', status: 'parse_failed', limits: [], plan: 'Plus'});
  check('not an object → parse_failed', whamPayload('<html>', NOW).status, 'parse_failed');
  // The plan: a fixed label from plan_type, never the raw text.
  check('plan_type plus → "Plus"', whamPayload(body(w(5 * HOUR, 39)), NOW).plan, 'Plus');
  check('plan_type free (seen live 2026-10-27) → "Free"', whamPayload({...body(w(30 * DAY, 100)), plan_type: 'free'}, NOW).plan, 'Free');
  check('unknown plan_type → no label', whamPayload({...body(w(5 * HOUR, 39)), plan_type: 'mystery_tier'}, NOW).plan, null);
  check('plan_type with markup → no label', whamPayload({...body(w(5 * HOUR, 39)), plan_type: '<b>pro</b>'}, NOW).plan, null);
  check('no plan_type → no label', whamPayload({rate_limit: body(w(5 * HOUR, 39)).rate_limit}, NOW).plan, null);
  const json = JSON.stringify(whamPayload(body(w(5 * HOUR, 39)), NOW));
  check('email, user id and account id go nowhere', ['user-secret-1', 'account-secret-2', 'someone@example.com'].filter(s => json.includes(s)), []);
}

console.log('\nthrough toSnapshot — the primary rule (CLAUDE.md §1)');
{
  const plus = toSnapshot(whamPayload(body(w(5 * HOUR, 39), w(7 * DAY, 60)), NOW), NOW);
  check('Plus: 5-hour', [plus.status, plus.primary_limit_id], ['ok', 'chatgpt_5h']);
  const pro = toSnapshot(whamPayload(body(w(7 * DAY, 25)), NOW), NOW);
  check('Pro: weekly (no 5-hour window at all)', [pro.status, pro.primary_limit_id], ['ok', 'chatgpt_weekly']);
  const month = toSnapshot(whamPayload(body(w(30 * DAY, 0)), NOW), NOW);
  check('30 days only: monthly', [month.status, month.primary_limit_id], ['ok', 'chatgpt_monthly']);
  const unreadable = toSnapshot(whamPayload(body(w(5 * HOUR, undefined), w(7 * DAY, 60)), NOW), NOW);
  check('5-hour window present but unreadable: not ok, weekly not promoted', [unreadable.status, unreadable.primary_limit_id], ['parse_failed', null]);
  const unplaced = toSnapshot(whamPayload(body(w(undefined, 39), w(7 * DAY, 60)), NOW), NOW);
  check('a window that can\'t be placed: not ok, weekly not promoted', [unplaced.status, unplaced.primary_limit_id], ['parse_failed', null]);
}

console.log('\ndiagnostics helpers — no ids, no email');
{
  check('whamWindows', whamWindows(body(w(5 * HOUR, 39), w(7 * DAY, 60))), [{seconds: 18000, used: 39}, {seconds: 604800, used: 60}]);
  check('whamWindows: odd values → null', whamWindows(body(w('x', '39'))), [{seconds: null, used: null}]);
  check('whamWindows: nothing', whamWindows(null), []);
  check('whamPlan', whamPlan(body(w(5 * HOUR, 39))), 'plus');
  check('whamPlan: free', whamPlan({plan_type: 'free'}), 'free');
  check('whamPlan: not plan-like (an email) → null', whamPlan({plan_type: 'someone@example.com'}), null);
  check('whamPlan: missing → null', whamPlan({}), null);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
