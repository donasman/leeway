// Run with: node tests/test_peers.mjs
//
// "Other Chrome profiles": what this profile sends to the Leeway helper
// (extension/peers.js), what it keeps from the reply, and how the other
// profiles' values are shown (view.js peerViews, snapshot.js fromShared).
// Another profile's entry crossed a process and a file, so it is checked again
// like any untrusted input.
import { cleanLabel, newProfileId, sharedSnapshots, helperError, peerRecord, helperOutdated, helperNote, MIN_HELPER_VERSION } from '../extension/peers.js';
import { peerViews } from '../extension/view.js';
import { fromShared, toSnapshot } from '../extension/snapshot.js';
import { readFileSync } from 'node:fs';

const KO = Object.fromEntries(Object.entries(
  JSON.parse(readFileSync(new URL('../extension/_locales/ko/messages.json', import.meta.url), 'utf8')),
).map(([key, value]) => [key, value.message]));

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  [${ok ? PASS : FAIL}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 3, 0, 0);
const iso = ms => new Date(ms).toISOString();
const limits = (fiveH, weekly) => [
  {id: 'claude_5h', label: '5-hour limit', remaining_percent: fiveH, resets_at: iso(NOW + 2 * 60 * MIN), reset_text: null},
  {id: 'claude_weekly', label: 'Weekly limit', remaining_percent: weekly, resets_at: null, reset_text: null},
];
const claudeOk = (agoMs, fiveH = 72, weekly = 41, extra = {}) => toSnapshot({provider: 'claude', status: 'ok', plan: 'Max 5x', limits: limits(fiveH, weekly), detail: 'secret-ish detail', ...extra}, NOW - agoMs);
const ID_SELF = '0123456789abcdef';
const ID_OTHER = 'fedcba9876543210';

console.log('\nwhat this profile sends');
{
  check('label: trimmed, control characters out', cleanLabel('  업무\u0007용  '), '업무용');
  check('label: 24 characters at most', cleanLabel('가'.repeat(30)).length, 24);
  check('label: not a string → empty', cleanLabel(42), '');
  check('profile id: hex of the random bytes', newProfileId(new Uint8Array([0, 1, 171, 255])), '0001abff');
  const ok = claudeOk(MIN);
  const failedLatest = toSnapshot({provider: 'chatgpt', status: 'parse_failed', limits: [], detail: 'usage: HTTP 500'}, NOW);
  const lastOkChatgpt = toSnapshot({provider: 'chatgpt', status: 'ok', plan: 'Free', limits: [{id: 'chatgpt_monthly', remaining_percent: 100}]}, NOW - 5 * MIN);
  const sent = sharedSnapshots([{latest: ok, lastOk: ok}, {latest: failedLatest, lastOk: lastOkChatgpt}, {latest: null, lastOk: null}]);
  check('the shown values only: latest ok, else last ok; nothing for a provider with none', sent.map(s => [s.provider, s.status]), [['claude', 'ok'], ['chatgpt', 'ok']]);
  check('no detail text goes out', sent.some(s => 'detail' in s), false);
  const huge = claudeOk(MIN, 50, 50, {accounts: Array.from({length: 4}, () => ({plan: 'Team', status: 'ok', limits: limits(10, 10)}))});
  huge.accounts.forEach(a => a.limits.forEach(l => { l.reset_text = 'x'.repeat(80); l.label = 'y'.repeat(40); }));
  const big = Array.from({length: 20}, () => ({latest: huge, lastOk: huge}));
  check('too large: accounts dropped first, then nothing rather than a cut list', JSON.stringify(sharedSnapshots(big)).length <= 15000, true);
}

console.log('\nwhat this profile keeps from the reply');
{
  // Chromium's wording (extensions/browser/api/messaging/native_message_host.cc
  // and message_service.cc), as chrome.runtime.lastError gives it.
  check('Chrome errors become codes', [
    'Specified native messaging host not found.',
    'Access to the specified native messaging host is forbidden.',
    'Access to the native messaging host was disabled by the system administrator.',
    'Failed to start native messaging host.',
    'Native host has exited.',
    'Error when communicating with the native messaging host.',
    'shared file is busy', // the helper's own error
    'no answer',
    undefined,
  ].map(helperError), ['helper_missing', 'helper_forbidden', 'helper_blocked', 'helper_failed', 'helper_failed', 'helper_failed', 'helper_failed', 'helper_failed', 'helper_failed']);
  const failedRecord = peerRecord({ok: false, error: 'Specified native messaging host not found.'}, ID_SELF, NOW);
  check('a failed round trip: error code, no version, no profiles', [failedRecord.ok, failedRecord.error, failedRecord.version, failedRecord.profiles], [false, 'helper_missing', null, []]);
  check('the helper answered with an error: its version is kept', peerRecord({ok: false, version: '0.6.3', error: 'shared file is busy'}, ID_SELF, NOW).version, '0.6.3');
  check('version kept only as x.y.z or dev', ['0.6.3', 'dev', '0.1.0', '1.2', 'v0.6.3', '<b>', 7, undefined].map(v => peerRecord({ok: true, version: v, profiles: []}, ID_SELF, NOW).version),
    ['0.6.3', 'dev', '0.1.0', null, null, null, null, null]);
  const record = peerRecord({ok: true, profiles: [
    {id: ID_SELF, label: 'me', updated_at: iso(NOW), snapshots: []},
    {id: ID_OTHER, label: '개인', updated_at: iso(NOW - 3 * MIN), snapshots: [claudeOk(3 * MIN)]},
    {id: 'NOT-HEX', label: 'x', updated_at: iso(NOW), snapshots: []},
    {id: 'aaaaaaaaaaaaaaaa', label: 'x', updated_at: iso(NOW), snapshots: 'nope'},
    null,
  ]}, ID_SELF, NOW);
  check('only other, well-formed profiles are kept', record.profiles.map(p => p.id), [ID_OTHER]);
}

console.log('\nhelper version — compared with MIN_HELPER_VERSION, "dev" passes');
{
  check('minimum', MIN_HELPER_VERSION, '0.6.3');
  check('older, same, newer, dev, none', ['0.1.0', '0.6.2', '0.6.3', '0.6.10', '0.7.0', '1.0.0', 'dev', null, undefined].map(v => helperOutdated(v)),
    [true, true, false, false, false, false, false, true, true]);
  check('numbers compare as numbers, not text', [helperOutdated('0.10.0', '0.9.0'), helperOutdated('0.9.0', '0.10.0')], [false, true]);
}

console.log('\nhelper state — one line on the cause, one on what to do');
{
  const at = iso(NOW - 3 * MIN);
  const note = record => helperNote(record, NOW, KO, 'abcdefghijklmnopabcdefghijklmnop');
  check('nothing yet: waiting, no lines', note(undefined), {state: 'waiting', lines: []});
  for (const code of ['helper_missing', 'helper_forbidden', 'helper_blocked', 'helper_failed']) {
    const got = note({at, ok: false, error: code, version: null, profiles: []});
    check(`${code}: cause, then action`, got, {state: code, lines: [KO[`peers_${code}_cause`], KO[`peers_${code}_action`].replace('{id}', 'abcdefghijklmnopabcdefghijklmnop')]});
  }
  check('forbidden: the unpacked copy gets its own extension id', note({at, ok: false, error: 'helper_forbidden', version: null, profiles: []}).lines[1].endsWith('--extension-id abcdefghijklmnopabcdefghijklmnop'), true);
  check('an unknown stored code reads as failed', note({at, ok: false, error: 'something', profiles: []}).state, 'helper_failed');
  check('outdated: both versions named', note({at, ok: true, error: null, version: '0.1.0', profiles: []}),
    {state: 'helper_outdated', lines: [KO.peers_helper_outdated_cause.replace('{version}', '0.1.0').replace('{min}', '0.6.3'), KO.peers_helper_outdated_action]});
  check('answered without a version: outdated, shown as "?"', note({at, ok: true, error: null, version: null, profiles: []}).lines[0], KO.peers_helper_outdated_cause.replace('{version}', '?').replace('{min}', '0.6.3'));
  check('ok: version and when it synced', note({at, ok: true, error: null, version: '0.6.3', profiles: []}), {state: 'ok', lines: [KO.peers_helper_ok.replace('{version}', '0.6.3').replace('{age}', '3분 전')]});
  check('ok, dev build', note({at, ok: true, error: null, version: 'dev', profiles: []}).state, 'ok');
  check('a record saved before versions were kept: ok, not judged', note({at, ok: true, error: null, profiles: []}), {state: 'ok', lines: []});
}

console.log('\nhow the other profiles show');
{
  const record = {profiles: [
    {id: ID_OTHER, label: '개인', updated_at: iso(NOW - 3 * MIN), snapshots: [claudeOk(3 * MIN, 0, 41)]},
    {id: 'aaaaaaaaaaaaaaaa', label: '<img src=x>', updated_at: iso(NOW - 20 * MIN), snapshots: [claudeOk(20 * MIN, 55, 80)]},
    {id: 'bbbbbbbbbbbbbbbb', label: '빈 프로필', updated_at: iso(NOW), snapshots: []},
  ]};
  // Written in remaining percentages; the used default has its own check below.
  const views = peerViews(record, NOW, 'Asia/Seoul', KO, 'remaining');
  check('profiles with something to show', views.map(v => v.label), ['개인', '<img src=x>']);
  check('when each last sent', views.map(v => v.updated), ['3분 전 갱신', '20분 전 갱신']);
  const first = views[0].providers[0];
  check('same view as the own profile: 0% stays 0%, plan kept', [first.provider, first.state, first.plan, first.rows.find(r => r.primary)?.percent], ['claude', 'ok', 'Max 5x', '0%']);
  check('an old value is stale and dimmed', [views[1].providers[0].state, views[1].providers[0].dim], ['stale', true]);
  const used = peerViews(record, NOW, 'Asia/Seoul', KO);
  check('used (the default): another profile turns the same way, 0 left is 100% used', used[0].providers[0].rows.map(r => r.percent), ['100%', '59%']);

  const bad = peerViews({profiles: [{id: ID_OTHER, label: '', updated_at: iso(NOW), snapshots: [
    {provider: 'claude', status: 'ok', collected_at: 'yesterday', limits: limits(50, 50)},
    {provider: 'claude', status: 'parse_failed', collected_at: iso(NOW), limits: []},
    {provider: 'evil', status: 'ok', collected_at: iso(NOW), limits: [{id: 'evil_5h', remaining_percent: 50}]},
    {provider: 'chatgpt', status: 'ok', collected_at: iso(NOW), limits: [{id: 'chatgpt_5h', remaining_percent: '50'}]},
    {provider: 'gemini', status: 'ok', collected_at: iso(NOW), plan: '<b>x</b>', limits: [{id: 'gemini_5h', remaining_percent: 140}]},
  ]}]}, NOW, 'Asia/Seoul', KO, 'remaining');
  check('checked again: bad time, not ok, unknown provider, a string percent are dropped', bad[0]?.providers.map(p => p.provider), ['gemini']);
  check('out-of-range clamped, a plan that is not a name dropped, empty label named Chrome', [bad[0]?.label, bad[0]?.providers[0].rows[0].percent, bad[0]?.providers[0].plan], ['Chrome', '100%', null]);
  check('fromShared keeps the time it was read', fromShared(claudeOk(7 * MIN))?.collected_at, iso(NOW - 7 * MIN));
  check('nothing stored → nothing shown', peerViews(undefined, NOW, 'Asia/Seoul', KO), []);
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
