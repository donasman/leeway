// Run with: node tests/test_view.mjs
//
// extension/view.js turns stored snapshots into what the popup shows. Stored
// values here are made by the real toSnapshot(), the way publish() stores them.
import {
  STALE_MS, asSnapshot, isStale, currentValues, primaryLimit, formatPercent,
  limitLabel as _limitLabel, formatAge as _formatAge, formatReset as _formatReset,
  providerView as _providerView, badgeView as _badgeView, BADGE_COLOR,
} from '../extension/view.js';
import { toSnapshot } from '../extension/snapshot.js';
import { readFileSync } from 'node:fs';

// popup.js / background.js build view.js's labels from chrome.i18n; here they
// come from the real _locales/ko file, so these tests assert the Korean UI
// output (same strings as before i18n). Wrapping the label-taking functions
// keeps every call site and assertion below unchanged.
const KO = Object.fromEntries(Object.entries(
  JSON.parse(readFileSync(new URL('../extension/_locales/ko/messages.json', import.meta.url), 'utf8')),
).map(([key, value]) => [key, value.message]));
const limitLabel = (limit) => _limitLabel(limit, KO);
const formatAge = (ageMs) => _formatAge(ageMs, KO);
const formatReset = (limit, nowMs, timeZone, collectedMs) => _formatReset(limit, nowMs, timeZone, collectedMs, KO);
const providerView = (input, nowMs, timeZone) => _providerView(input, nowMs, timeZone, KO);
const badgeView = (entries, nowMs, timeZone) => _badgeView(entries, nowMs, timeZone, KO);

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

const MIN = 60 * 1000;
const H = 60 * MIN;
const NOW = Date.UTC(2026, 9, 15, 4, 12, 0); // 2026-10-15T04:12:00Z = Thu 13:12 in Seoul
const TZ = 'Asia/Seoul';
const iso = ms => new Date(ms).toISOString();
const limit = (id, remaining_percent, extra = {}) => ({id, label: id, remaining_percent, resets_at: null, reset_text: null, ...extra});
const stored = (provider, status, limits, agoMs, detail = '') =>
  toSnapshot({provider, status, value: '', detail, limits}, NOW - agoMs);
const view = (input, nowMs = NOW) => providerView(input, nowMs, TZ);
const on = {enabled: true, permitted: true};

const claudeOk = (agoMs = 2 * MIN) => stored('claude', 'ok', [
  limit('claude_5h', 60, {label: '5-hour limit', resets_at: iso(NOW + 4 * H + 20 * MIN + 30 * 1000), reset_text: 'resets 10/15, 05:32 PM'}),
  limit('claude_weekly', 0, {label: 'Weekly limit', resets_at: '2026-10-20T00:00:00Z'}),
], agoMs);
const claudeRows = [
  {id: 'claude_5h', label: '5시간', percent: '60%', reset: '4시간 20분 후 초기화', primary: true},
  {id: 'claude_weekly', label: '주간', percent: '0%', reset: '10/20 (화) 09:00 초기화', primary: false},
];
const chatgptOk = (agoMs = 2 * MIN) => stored('chatgpt', 'ok', [
  limit('chatgpt_5h', 61, {label: '5-hour limit', reset_text: '4시간 20분 후 초기화'}),
  limit('chatgpt_weekly', 60, {label: 'Weekly limit', reset_text: '6일 0시간 후 초기화'}),
], agoMs);
// The page's wording is recounted from collected_at (+ half its last unit):
// 2 min later "4시간 20분" is 4 h 18 min 30 s away, "6일 0시간" still 6 d 0 h.
const chatgptRows = fiveHourReset => [
  {id: 'chatgpt_5h', label: '5시간', percent: '61%', reset: fiveHourReset, primary: true},
  {id: 'chatgpt_weekly', label: '주간', percent: '60%', reset: '6일 0시간 후 초기화', primary: false},
];
const failedRead = (provider, agoMs, detail) => stored(provider, 'parse_failed', [], agoMs, detail);

// ---------------------------------------------------------------------------
console.log('\nasSnapshot — null or no status reads as nothing stored (CLAUDE.md §2)');
{
  check('null', asSnapshot(null), null);
  check('undefined', asSnapshot(undefined), null);
  check('string', asSnapshot('ok'), null);
  check('{} (no status)', asSnapshot({}), null);
  check('non-string status', asSnapshot({status: 1}), null);
  const s = claudeOk();
  check('snapshot comes back as is', asSnapshot(s) === s, true);
}

console.log('\nisStale — 6 minutes (CLAUDE.md §4)');
{
  check('STALE_MS', STALE_MS, 6 * MIN);
  check('exactly 6 min old → fresh', isStale(claudeOk(6 * MIN), NOW), false);
  check('6 min + 1 ms → stale', isStale(claudeOk(6 * MIN + 1), NOW), true);
  check('no collected_at → stale', isStale({status: 'ok'}, NOW), true);
  check('unreadable collected_at → stale', isStale({status: 'ok', collected_at: 'yesterday'}, NOW), true);
  check('null → stale', isStale(null, NOW), true);
  check('1 min in the future (clock skew) → fresh', isStale(claudeOk(-MIN), NOW), false);
  check('more than 1 min in the future (clock set back) → stale', isStale(claudeOk(-MIN - 1), NOW), true);
  check('2 days in the future → stale', isStale(claudeOk(-2 * 24 * H), NOW), true);
}

console.log('\ncurrentValues — latest when ok, else the last ok one after a failed read');
{
  const ok = chatgptOk(9 * MIN);
  const pick = (latest, lastOk) => {
    const shown = currentValues(latest, lastOk);
    return shown && [shown.snapshot === ok ? 'lastOk' : shown.snapshot === latest ? 'latest' : '?', shown.fromLastOk];
  };
  const latestOk = chatgptOk();
  check('ok latest', pick(latestOk, ok), ['latest', false]);
  check('ok latest, no last ok stored', pick(latestOk, null), ['latest', false]);
  check('parse_failed → last ok, marked', pick(failedRead('chatgpt', MIN, 'x'), ok), ['lastOk', true]);
  check('logged_out → last ok, marked', pick(stored('chatgpt', 'logged_out', [], MIN), ok), ['lastOk', true]);
  check('parse_failed, no last ok → nothing', pick(failedRead('chatgpt', MIN, 'x'), null), null);
  check('needs_permission → nothing', pick(stored('chatgpt', 'needs_permission', [], MIN), ok), null);
  check('disabled → nothing', pick(stored('chatgpt', 'disabled', [], MIN), ok), null);
  check('no latest → last ok, not marked', pick(undefined, ok), ['lastOk', false]);
  check('latest without status → last ok, not marked', pick({}, ok), ['lastOk', false]);
  check('nothing stored', pick(undefined, undefined), null);
  check('last ok cleared (null)', pick(undefined, null), null);
}

console.log('\nprimaryLimit — only from an ok snapshot (CLAUDE.md §1)');
{
  check('5-hour', primaryLimit(claudeOk())?.id, 'claude_5h');
  const pro = stored('chatgpt', 'ok', [limit('chatgpt_weekly', 40)], 0);
  check('no 5-hour limit at all (Pro) → weekly', primaryLimit(pro)?.id, 'chatgpt_weekly');
  const zero = stored('claude', 'ok', [limit('claude_5h', 0)], 0);
  check('0 is a readable primary', primaryLimit(zero)?.remaining_percent, 0);
  check('not ok → none', primaryLimit(failedRead('claude', 0, 'x')), null);
  check('not ok but a primary id left in storage → none',
    primaryLimit({status: 'parse_failed', primary_limit_id: 'claude_5h', limits: [{id: 'claude_5h', remaining_percent: 50}]}), null);
  check('id not among limits → none', primaryLimit({status: 'ok', primary_limit_id: 'claude_5h', limits: []}), null);
  check('primary without a value → none',
    primaryLimit({status: 'ok', primary_limit_id: 'claude_5h', limits: [{id: 'claude_5h', remaining_percent: null}]}), null);
  check('no primary_limit_id → none (an id-less limit never matches)',
    primaryLimit({status: 'ok', primary_limit_id: null, limits: [{remaining_percent: 50}]}), null);
  check('limits not an array → none', primaryLimit({status: 'ok', primary_limit_id: 'claude_5h', limits: 'x'}), null);
  check('non-object entries are skipped',
    primaryLimit({status: 'ok', primary_limit_id: 'claude_5h', limits: [null, 'x', 7, {id: 'claude_5h', remaining_percent: 50}]})?.remaining_percent, 50);
}

console.log('\nformatPercent — 0 is "0%", only a missing value is "?" (CLAUDE.md §1)');
{
  check('0', formatPercent(0), '0%');
  check('61', formatPercent(61), '61%');
  check('100', formatPercent(100), '100%');
  check('60.4 rounds', formatPercent(60.4), '60%');
  check('60.5 rounds', formatPercent(60.5), '61%');
  check('null', formatPercent(null), '?');
  check('undefined', formatPercent(undefined), '?');
  check('string "61" is not coerced', formatPercent('61'), '?');
  check('NaN', formatPercent(NaN), '?');
  check('Infinity', formatPercent(Infinity), '?');
}

console.log('\nlimitLabel');
{
  check('chatgpt_5h', limitLabel({id: 'chatgpt_5h', label: '5-hour limit'}), '5시간');
  check('claude_weekly', limitLabel({id: 'claude_weekly', label: 'Weekly limit'}), '주간');
  check('gemini_5h (planned id)', limitLabel({id: 'gemini_5h', label: '현재 사용량'}), '5시간');
  check('chatgpt_monthly (30-day window)', limitLabel({id: 'chatgpt_monthly', label: 'Monthly limit'}), '월간');
  check('unknown kind → stored label', limitLabel({id: 'chatgpt_86400s', label: '1-day limit'}), '1-day limit');
  check('unknown kind, empty label → id', limitLabel({id: 'chatgpt_x', label: ''}), 'chatgpt_x');
  check('"constructor" is not looked up on Object.prototype', limitLabel({id: 'chatgpt_constructor', label: 'C'}), 'C');
  check('"__proto__" is not looked up on Object.prototype', limitLabel({id: 'chatgpt___proto__', label: 'P'}), 'P');
  check('"toString" is not looked up on Object.prototype', limitLabel({id: 'chatgpt_toString', label: 'T'}), 'T');
}

console.log('\nformatAge');
{
  check('0', formatAge(0), '방금');
  check('59.999 s', formatAge(MIN - 1), '방금');
  check('1 min', formatAge(MIN), '1분 전');
  check('59 min 59 s', formatAge(H - 1000), '59분 전');
  check('1 h', formatAge(H), '1시간 전');
  check('23 h 59 min', formatAge(24 * H - MIN), '23시간 전');
  check('24 h', formatAge(24 * H), '1일 전');
  check('3 days 5 h', formatAge(3 * 24 * H + 5 * H), '3일 전');
  check('negative (clock skew)', formatAge(-5000), '방금');
  check('-1 min', formatAge(-MIN), '방금');
  check('more than 1 min ahead → no age', formatAge(-MIN - 1), '');
  check('NaN', formatAge(NaN), '');
}

console.log('\nformatReset — relative within a day, local date after that');
{
  const at = ms => formatReset({resets_at: iso(NOW + ms)}, NOW, TZ);
  check('4 h 20 min 30 s', at(4 * H + 20 * MIN + 30 * 1000), '4시간 20분 후 초기화');
  check('4 h even', at(4 * H), '4시간 후 초기화');
  check('20 min', at(20 * MIN), '20분 후 초기화');
  check('30 s → 1 min', at(30 * 1000), '1분 후 초기화');
  check('23 h 59 min', at(23 * H + 59 * MIN), '23시간 59분 후 초기화');
  check('24 h → date (Fri)', at(24 * H), '10/16 (금) 13:12 초기화');
  check('UTC midnight Oct 20 in Seoul', formatReset({resets_at: '2026-10-20T00:00:00.000Z'}, NOW, TZ), '10/20 (화) 09:00 초기화');
  check('Seoul midnight is 00:00, not 24:00', formatReset({resets_at: '2026-10-19T15:00:00.000Z'}, NOW, TZ), '10/20 (화) 00:00 초기화');
  check('time zone is honored (UTC)', formatReset({resets_at: '2026-10-20T00:00:00.000Z'}, NOW, 'UTC'), '10/20 (화) 00:00 초기화');
  check('reset time reached', at(0), '초기화 시각 지남');
  check('reset time passed', at(-MIN), '초기화 시각 지남');
  check('resets_at wins over reset_text',
    formatReset({resets_at: iso(NOW + 20 * MIN), reset_text: 'resets 10/15, 01:32 PM'}, NOW, TZ), '20분 후 초기화');
  check('no resets_at, no collected time → page wording as stored', formatReset({resets_at: null, reset_text: '6일 0시간 후 초기화'}, NOW, TZ), '6일 0시간 후 초기화');
  check('unreadable resets_at → page wording', formatReset({resets_at: 'soon', reset_text: 'x'}, NOW, TZ), 'x');
  check('nothing → empty', formatReset({}, NOW, TZ), '');
}

console.log('\nformatReset — the page\'s relative wording is recounted from when it was read');
{
  const page = (text, agoMs) => formatReset({resets_at: null, reset_text: text}, NOW, TZ, NOW - agoMs);
  check('just read: unchanged', page('4시간 20분 후 초기화', 0), '4시간 20분 후 초기화');
  check('2 min later', page('4시간 20분 후 초기화', 2 * MIN), '4시간 18분 후 초기화');
  check('3 h later', page('4시간 20분 후 초기화', 3 * H), '1시간 20분 후 초기화');
  check('hours run out → minutes only', page('4시간 20분 후 초기화', 4 * H), '20분 후 초기화');
  check('past it', page('4시간 20분 후 초기화', 4 * H + 21 * MIN), '초기화 시각 지남');
  check('days + hours, 2 min later: still the same hour', page('6일 0시간 후 초기화', 2 * MIN), '6일 0시간 후 초기화');
  check('days + hours, 2 h later', page('6일 0시간 후 초기화', 2 * H), '5일 22시간 후 초기화');
  check('days run out → hours only', page('6일 0시간 후 초기화', 5 * 24 * H + H), '23시간 후 초기화');
  check('minutes only', page('20분 후 초기화', 5 * MIN), '15분 후 초기화');
  check('days only, in days', page('3일 후 초기화', 24 * H), '2일 후 초기화');
  check('clock set back since the read: no time added', page('4시간 20분 후 초기화', -2 * 24 * H), '4시간 20분 후 초기화');
  check('other wording (English UI) stays as stored', page('resets in 4h 20m', 3 * H), 'resets in 4h 20m');
  check('no number stays as stored', page('후 초기화', 3 * H), '후 초기화');
}

// ---------------------------------------------------------------------------
console.log('\nproviderView — off and permission are live, and win over storage');
{
  const empty = {rows: [], dim: false, note: '', detail: ''};
  check('off: nothing shown even with stored values',
    view({enabled: false, permitted: true, latest: claudeOk(), lastOk: claudeOk()}), {state: 'off', status: '꺼짐', ...empty});
  check('enabled without permission',
    view({enabled: true, permitted: false, latest: claudeOk(), lastOk: claudeOk()}),
    {state: 'needs_permission', status: '권한 필요', ...empty, note: '사이트 권한이 없습니다. 껐다 켜서 허용하세요.'});
  check('nothing stored yet', view({...on}), {state: 'waiting', status: '대기 중', ...empty});
  check('re-enabled, disabled snapshot still stored (its detail is not a failure)',
    view({...on, latest: stored('claude', 'disabled', [], MIN, 'disabled by user'), lastOk: null}), {state: 'waiting', status: '대기 중', ...empty});
  check('permission granted again, needs_permission still stored',
    view({...on, latest: stored('claude', 'needs_permission', [], MIN, 'Grant claude.ai permission in extension popup'), lastOk: null}),
    {state: 'waiting', status: '대기 중', ...empty});
}

console.log('\nproviderView — ok');
{
  const s = claudeOk();
  const input = {...on, latest: s, lastOk: s};
  const before = JSON.stringify(input);
  const v = view(input);
  check('state', v.state, 'ok');
  check('status', v.status, '정상');
  check('rows (5-hour is primary, weekly 0 stays 0%)', v.rows, claudeRows);
  check('not dimmed', v.dim, false);
  check('note', v.note, '2분 전 확인');
  check('no detail', v.detail, '');
  check('input not mutated', JSON.stringify(input), before);
  const legacy = stored('claude', 'ok', [limit('claude_5h', 60)], 0, '5-hour limit: 60% remaining');
  check('an ok snapshot\'s detail (legacy summary) is not a failure reason', view({...on, latest: legacy, lastOk: legacy}).detail, '');
  check('ChatGPT (DOM: page wording, recounted)', view({...on, latest: chatgptOk(), lastOk: chatgptOk()}).rows, chatgptRows('4시간 18분 후 초기화'));
  const pro = stored('chatgpt', 'ok', [limit('chatgpt_weekly', 40, {reset_text: '3일 후 초기화'})], 0);
  check('no 5-hour limit at all (Pro): weekly row is primary, labeled 주간',
    view({...on, latest: pro, lastOk: pro}).rows,
    [{id: 'chatgpt_weekly', label: '주간', percent: '40%', reset: '3일 후 초기화', primary: true}]);
}

console.log('\nproviderView — stale after 6 minutes');
{
  const fresh = claudeOk(6 * MIN);
  check('exactly 6 min → ok', view({...on, latest: fresh, lastOk: fresh}).state, 'ok');
  const old = claudeOk(6 * MIN + 1);
  const v = view({...on, latest: old, lastOk: old});
  check('state', v.state, 'stale');
  check('status', v.status, '오래됨');
  check('dimmed', v.dim, true);
  check('values still shown', v.rows.map(r => r.percent), ['60%', '0%']);
  check('note', v.note, '오래된 값 · 6분 전 확인');
}

console.log('\nproviderView — failed read after an ok one: last ok values, marked');
{
  const detail = 'Settings > Usage route/dialog was not detected';
  const v = view({...on, latest: failedRead('chatgpt', MIN, detail), lastOk: chatgptOk(9 * MIN)});
  check('state', v.state, 'parse_failed');
  check('status', v.status, '읽기 실패');
  check('rows = last ok, resets recounted from when it was read', v.rows, chatgptRows('4시간 11분 후 초기화'));
  check('dimmed', v.dim, true);
  check('note', v.note, '마지막 정상 값 · 9분 전');
  check('detail for the tooltip', v.detail, detail);
  const fresh = view({...on, latest: failedRead('chatgpt', 0, detail), lastOk: chatgptOk(20 * 1000)});
  check('last ok only seconds old: still dimmed and marked', [fresh.dim, fresh.note], [true, '마지막 정상 값 · 방금']);
  const out = view({...on, latest: stored('claude', 'logged_out', [], MIN, 'Claude usage unavailable: auth-401'), lastOk: claudeOk(9 * MIN)});
  check('logged_out: status', out.status, '로그인 필요');
  check('logged_out: last ok shown, 5-hour still primary', out.rows.map(r => [r.percent, r.primary]), [['60%', true], ['0%', false]]);
  check('logged_out: dimmed', out.dim, true);
}

console.log('\nproviderView — failed read, nothing ok before');
{
  const out = view({...on, latest: stored('claude', 'logged_out', [], MIN, 'Claude usage unavailable: auth-401'), lastOk: null});
  check('logged_out', [out.status, out.rows, out.note, out.detail],
    ['로그인 필요', [], '1분 전 확인 · 로그인하면 표시됩니다', 'Claude usage unavailable: auth-401']);
  const none = view({...on, latest: failedRead('chatgpt', MIN, 'ChatGPT Usage UI unavailable: no-scan-response'), lastOk: null});
  check('parse_failed', [none.status, none.rows, none.note], ['읽기 실패', [], '1분 전 확인 · 값을 읽지 못했습니다']);
  const asleep = view({...on, latest: stored('claude', 'logged_out', [], 8 * H, 'Claude usage unavailable: auth-401'), lastOk: null});
  check('an old failure says how old it is', asleep.note, '8시간 전 확인 · 로그인하면 표시됩니다');
  const domPartial = stored('chatgpt', 'parse_failed', [limit('chatgpt_weekly', 60, {reset_text: '6일 0시간 후 초기화'})], 0,
    '5-hour card found, but its remaining percentage was not found');
  check('ChatGPT DOM partial (5-hour left out): "5시간 ?" shown, weekly not alone',
    view({...on, latest: domPartial, lastOk: null}).rows, [
      {id: 'chatgpt_5h', label: '5시간', percent: '?', reset: '', primary: false},
      {id: 'chatgpt_weekly', label: '주간', percent: '60%', reset: '6일 0시간 후 초기화', primary: false},
    ]);
  const junk = stored('claude', 'ok', [limit('claude_5h', 50)], 0);
  junk.limits.unshift(null, 'x');
  check('non-object limits skipped, not thrown on', view({...on, latest: junk, lastOk: junk}).rows.map(r => r.percent), ['50%']);
  // What background stores when the Claude 5-hour value is unreadable: the
  // collector says ok with claude_5h null, toSnapshot() downgrades it.
  const partial = toSnapshot({provider: 'claude', status: 'ok', value: '?', detail: '', limits: [
    limit('claude_5h', null), limit('claude_weekly', 70, {resets_at: '2026-10-20T00:00:00Z'}),
  ]}, NOW - 20 * 1000);
  const p = view({...on, latest: partial, lastOk: null});
  check('partial: stored as parse_failed', partial.status, 'parse_failed');
  check('partial: 5-hour "?", weekly shown, neither primary (weekly never promoted)', p.rows, [
    {id: 'claude_5h', label: '5시간', percent: '?', reset: '', primary: false},
    {id: 'claude_weekly', label: '주간', percent: '70%', reset: '10/20 (화) 09:00 초기화', primary: false},
  ]);
  check('partial: status', p.status, '읽기 실패');
  check('partial: note', p.note, '일부만 읽음 · 방금 확인');
  check('partial: not dimmed while fresh', p.dim, false);
  check('partial: detail', p.detail, 'ok payload, but claude_5h has no value');
  const pOld = view({...on, latest: partial, lastOk: null}, NOW + 7 * MIN);
  check('partial: dimmed once stale', [pOld.dim, pOld.note], [true, '일부만 읽음 · 7분 전 확인']);
}

console.log('\nproviderView — odd storage');
{
  const v = view({...on, latest: {}, lastOk: chatgptOk(9 * MIN)});
  check('latest without status: last ok shown as stale', [v.state, v.dim, v.note], ['stale', true, '오래된 값 · 9분 전 확인']);
  const w = view({...on, latest: {status: 'surprise', collected_at: iso(NOW)}, lastOk: null});
  check('unknown status → waiting', w.state, 'waiting');
}

console.log('\nbadgeView — the lowest primary value among the enabled providers (CLAUDE.md §4)');
{
  const entry = (name, extra = {}) => ({name, enabled: true, permitted: true, latest: undefined, lastOk: undefined, ...extra});
  const both = (name, snapshot) => entry(name, {latest: snapshot, lastOk: snapshot});
  const claude = (fiveHour, agoMs = 2 * MIN) => both('Claude', stored('claude', 'ok', [
    limit('claude_5h', fiveHour, {resets_at: iso(NOW + 4 * H)}),
    limit('claude_weekly', 65, {resets_at: '2026-10-20T00:00:00Z'}),
  ], agoMs));
  const chatgpt = (monthly, agoMs = MIN) => both('ChatGPT', stored('chatgpt', 'ok', [
    limit('chatgpt_monthly', monthly, {resets_at: '2026-11-14T11:39:00Z'}),
  ], agoMs));
  const badge = (...entries) => badgeView(entries, NOW, TZ);

  check('nothing on → empty', badge(entry('Claude', {enabled: false}), entry('ChatGPT', {enabled: false})),
    {text: '', color: BADGE_COLOR.grey, title: 'Leeway — 켜진 서비스가 없습니다'});
  check('one value, digits only', badge(claude(70)).text, '70');
  check('lowest of two', badge(claude(70), chatgpt(100)).text, '70');
  check('lowest of two, other order', badge(chatgpt(30), claude(70)).text, '30');
  check('50 → green', badge(claude(50)).color, BADGE_COLOR.green);
  check('49.6 shows as 50 → green', [badge(claude(49.6)).text, badge(claude(49.6)).color], ['50', BADGE_COLOR.green]);
  check('49 → orange', badge(claude(49)).color, BADGE_COLOR.orange);
  check('20 → orange', badge(claude(20)).color, BADGE_COLOR.orange);
  check('19 → red', badge(claude(19)).color, BADGE_COLOR.red);
  check('0 → "0", red (0 is a value)', [badge(claude(0)).text, badge(claude(0)).color], ['0', BADGE_COLOR.red]);
  check('older than 6 minutes → grey', badge(claude(70, 7 * MIN)).color, BADGE_COLOR.grey);
  check('exactly 6 minutes → still green', badge(claude(70, 6 * MIN)).color, BADGE_COLOR.green);
  check('the lowest decides the colour: stale lowest → grey', badge(claude(10, 7 * MIN), chatgpt(90)).color, BADGE_COLOR.grey);
  check('...fresh lowest → its colour', badge(claude(10), chatgpt(90, 7 * MIN)).color, BADGE_COLOR.red);
  check('on, no value yet → "?"', badge(entry('Claude')), {text: '?', color: BADGE_COLOR.grey, title: 'Leeway\nClaude: 대기 중'});
  check('on, permission gone → not counted', badge({...claude(10), permitted: false}, chatgpt(90)).text, '90');
  check('a provider without a value does not hide the other',
    badge(entry('Claude', {latest: stored('claude', 'logged_out', [], MIN), lastOk: null}), chatgpt(90)).text, '90');
  const lastOk = stored('chatgpt', 'ok', [limit('chatgpt_monthly', 40, {resets_at: '2026-11-14T11:39:00Z'})], 2 * MIN);
  const failedThen = badge(entry('ChatGPT', {latest: stored('chatgpt', 'parse_failed', [], MIN, 'x'), lastOk}));
  check('failed read → the last ok value, marked in the tooltip', [failedThen.text, failedThen.title.split('\n')[1]],
    ['40', 'ChatGPT: 월간 40% 남음 · 11/14 (토) 20:39 초기화 (읽기 실패 · 마지막 정상 값)']);
  const partial = toSnapshot({provider: 'claude', status: 'ok', value: '?', detail: '', limits: [
    limit('claude_5h', null), limit('claude_weekly', 70),
  ]}, NOW);
  check('5-hour unreadable: the weekly value is not used', badge(entry('Claude', {latest: partial, lastOk: null})).text, '?');
  check('no 5-hour limit at all (Pro): weekly', badge(both('ChatGPT', stored('chatgpt', 'ok', [limit('chatgpt_weekly', 25)], 0))).text, '25');
  check('tooltip: a line per enabled provider', badge(claude(70), chatgpt(100), entry('Gemini', {enabled: false})).title.split('\n'), [
    'Leeway',
    'Claude: 5시간 70% 남음 · 4시간 후 초기화',
    'ChatGPT: 월간 100% 남음 · 11/14 (토) 20:39 초기화',
  ]);
  check('tooltip marks a stale value', badge(claude(70, 7 * MIN)).title.split('\n')[1], 'Claude: 5시간 70% 남음 · 4시간 후 초기화 (오래됨)');
  check('tooltip names a provider without a value', badge(claude(70), entry('ChatGPT', {permitted: false})).title.split('\n')[2], 'ChatGPT: 권한 필요');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
