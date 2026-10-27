// Run with: node tests/test_popup.mjs   (once: npm install — jsdom)
//
// Loads the real extension/popup.html into jsdom and imports the real popup.js
// (no copied source, CLAUDE.md §5) with an in-memory chrome.* stub. Covers
// what the popup puts on screen for stored snapshots, that text from web pages
// stays text, and what the toggles ask background to do. Stored values are
// made by the real toSnapshot(), the way publish() stores them.
//
// background.js is not loaded here: the stub answers PROVIDER_ENABLED /
// PROVIDER_DISABLED with the storage changes background makes (what background
// really does is test_background.mjs). Not covered: layout and CSS, the real
// permission prompt — overlay-verify's "사용자 확인 필요" list.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
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

const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
// chrome.i18n.getMessage returns the Korean strings, so the popup renders in
// Korean and the assertions below are unchanged (CLAUDE.md §2 다국어).
const koMessages = JSON.parse(readFileSync(new URL('../extension/_locales/ko/messages.json', import.meta.url), 'utf8'));
const KO = Object.fromEntries(Object.entries(koMessages).map(([key, value]) => [key, value.message]));

const MIN = 60 * 1000;
const H = 60 * MIN;
const CLAUDE = 'https://claude.ai/*';
const CHATGPT = 'https://chatgpt.com/*';
const GEMINI = 'https://gemini.google.com/*';
const HOSTS = {claude: CLAUDE, chatgpt: CHATGPT, gemini: GEMINI};

const limit = (id, remaining_percent, extra = {}) => ({id, label: id, remaining_percent, resets_at: null, reset_text: null, ...extra});
const snapshot = (provider, status, limits, agoMs, detail = '') =>
  toSnapshot({provider, status, value: '', detail, limits}, Date.now() - agoMs);

// ---- chrome.* stub ---------------------------------------------------------

const store = new Map();
const granted = new Set();
let changeListeners = [];
const calls = []; // what the popup itself did, in order
let permissionAnswer = true;
let requestGate = null;
let refreshGate = null;
let getGate = null;
let activeTab = {id: 1, url: 'https://example.com/'};

// Like Chrome: onChanged comes later, and only for values that changed.
// (setImmediate, not setTimeout: Windows timers tick every ~15 ms.)
function write(items) {
  const changes = {};
  for (const [key, value] of Object.entries(items)) {
    if (JSON.stringify(store.get(key)) === JSON.stringify(value)) continue;
    changes[key] = {oldValue: store.get(key), newValue: value};
    store.set(key, structuredClone(value));
  }
  if (Object.keys(changes).length) setImmediate(() => changeListeners.forEach(fn => fn(changes, 'local')));
}

// The storage side of what background.js does for the toggle messages.
function background(message) {
  const enabled = new Set(store.get('enabledProviders') || []);
  const host = HOSTS[message.provider];
  if (message.type === 'PROVIDER_ENABLED' && granted.has(host)) {
    enabled.add(message.provider);
    write({enabledProviders: [...enabled]});
  }
  if (message.type === 'PROVIDER_DISABLED') {
    enabled.delete(message.provider);
    write({enabledProviders: [...enabled]});
    write({[`usage_${message.provider}`]: snapshot(message.provider, 'disabled', [], 0, 'disabled by user'), [`usage_last_ok_${message.provider}`]: null});
    granted.delete(host);
  }
  // Other Chrome profiles: what background.js writes for these messages.
  if (message.type === 'PEERS_ENABLE' && granted.has('nativeMessaging')) {
    write({peer_settings: {on: true, id: '0123456789abcdef', label: String(message.label || '').trim()}});
  }
  if (message.type === 'PEERS_DISABLE') {
    write({peer_settings: {on: false, id: '0123456789abcdef', label: ''}});
    store.delete('peer_profiles');
    granted.delete('nativeMessaging');
  }
  if (message.type === 'PEERS_LABEL') {
    write({peer_settings: {...store.get('peer_settings'), label: String(message.label || '').trim()}});
  }
}

globalThis.chrome = {
  i18n: {
    getMessage: (key) => KO[key] ?? '',
    getUILanguage: () => 'ko',
  },
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const key of [].concat(keys)) if (store.has(key)) out[key] = structuredClone(store.get(key));
        if (getGate) await getGate; // what was stored at the call, delivered later
        return out;
      },
      async set(items) {
        calls.push(['storage.set', structuredClone(items)]);
        write(items);
      },
    },
    onChanged: {addListener: fn => changeListeners.push(fn)},
  },
  runtime: {
    getManifest: () => structuredClone(manifest),
    async sendMessage(message) {
      calls.push(['runtime.sendMessage', message.type, ...(message.label !== undefined ? [message.label] : [])]);
      if (message.type === 'REFRESH_ALL' && refreshGate) await refreshGate;
      background(message);
      return {ok: true};
    },
  },
  permissions: {
    async contains({origins = [], permissions = []}) { return [...origins, ...permissions].every(item => granted.has(item)); },
    async request({origins, permissions}) {
      calls.push(['permissions.request', origins ?? permissions]);
      if (requestGate) await requestGate; // the prompt is open
      if (permissionAnswer) [...(origins || []), ...(permissions || [])].forEach(item => granted.add(item));
      return permissionAnswer;
    },
    async remove({origins}) {
      calls.push(['permissions.remove', origins]);
      origins.forEach(origin => granted.delete(origin));
      return true;
    },
  },
  tabs: {
    async query() { return [activeTab]; },
  },
  scripting: {
    async executeScript(opts) { calls.push(['scripting.executeScript', opts.files]); return [{result: undefined}]; },
  },
};

// ---- helpers ---------------------------------------------------------------

const $ = id => globalThis.document.getElementById(id);
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const rows = provider => [...$(`limits_${provider}`).children].map(row => [...row.children].map(cell => cell.textContent));
const card = provider => ({
  status: $(`status_${provider}`).textContent,
  rows: rows(provider),
  dim: $(`limits_${provider}`).classList.contains('dim'),
  note: $(`note_${provider}`).textContent,
});
// Resets relative to now, so the text doesn't depend on the machine's time zone.
const claudeOk = ({agoMs = 2 * MIN, fiveHour = 60} = {}) => snapshot('claude', 'ok', [
  limit('claude_5h', fiveHour, {resets_at: new Date(Date.now() + 4 * H + 20 * MIN + 30 * 1000).toISOString()}),
  limit('claude_weekly', 0, {resets_at: new Date(Date.now() + 20 * H + 5 * MIN + 30 * 1000).toISOString()}),
], agoMs);
const chatgptOk = agoMs => snapshot('chatgpt', 'ok', [
  limit('chatgpt_5h', 61, {reset_text: '4시간 20분 후 초기화'}),
  limit('chatgpt_weekly', 60, {reset_text: '6일 0시간 후 초기화'}),
], agoMs);
// Gemini: as background stores it — resets_at computed by geminiPayload, plus
// the raw wording in reset_text. gemini_5h ("현재 사용량") is the primary row.
const geminiOk = (agoMs = 2 * MIN) => snapshot('gemini', 'ok', [
  limit('gemini_5h', 100, {resets_at: new Date(Date.now() + 4 * H + 20 * MIN + 30 * 1000).toISOString(), reset_text: '오후 10:19에 초기화'}),
  limit('gemini_weekly', 100, {resets_at: new Date(Date.now() + 20 * H + 5 * MIN + 30 * 1000).toISOString(), reset_text: '10월 16일 오후 4:19에 초기화'}),
], agoMs);
// Written the way background writes: storage → onChanged → the popup re-renders.
const storeAndRender = async items => { write(items); await settle(); };
const clickAndSettle = async id => { calls.length = 0; $(id).click(); await settle(); };

// A fresh popup.html + popup.js, as when the user opens the popup. The previous
// one counts as closed: its storage listener is dropped. popup.js's 30-second
// timer is captured instead of started; tick() runs it.
let tick = null;
async function openPopup(tag) {
  globalThis.document = new JSDOM(html).window.document; // the page's own <script> is not run
  changeListeners = [];
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { timers.push({fn, ms}); return timers.length; };
  try { await import(`../extension/popup.js?open=${tag}`); }
  finally { globalThis.setInterval = realSetInterval; }
  const timer = timers.find(t => t.ms === 30 * 1000);
  tick = async () => { await timer.fn(); await settle(); };
  await settle();
  return timers.map(t => t.ms);
}

// ---- what is stored when the popup opens -----------------------------------

const detail = 'Settings > Usage route/dialog was not detected';
granted.add(CLAUDE);
granted.add(CHATGPT);
store.set('enabledProviders', ['claude', 'chatgpt']);
const claude = claudeOk();
store.set('usage_claude', claude);
store.set('usage_last_ok_claude', claude);
store.set('usage_chatgpt', snapshot('chatgpt', 'parse_failed', [], MIN, detail));
store.set('usage_last_ok_chatgpt', chatgptOk(9 * MIN));

const timers = await openPopup('first');

// ---------------------------------------------------------------------------
console.log('\nopened — values from storage, no desktop app running');
{
  check('version from manifest', $('version').textContent, `v${manifest.version}`);
  check('static lang matches the manifest default_locale', new JSDOM(html).window.document.documentElement.lang, manifest.default_locale);
  check('lang set from the UI language on load', document.documentElement.lang, 'ko');
  check('claude', card('claude'), {
    status: '정상',
    rows: [['5시간', '60%', '4시간 20분 후 초기화'], ['주간', '0%', '20시간 5분 후 초기화']],
    dim: false,
    note: '2분 전 확인',
  });
  check('claude: 5-hour row is the primary one',
    [...$('limits_claude').querySelectorAll('.limit.primary .label')].map(cell => cell.textContent), ['5시간']);
  check('claude: status class', $('status_claude').className, 'badge ok');
  check('chatgpt: failed read shows the last ok values, dimmed, resets counted from then', card('chatgpt'), {
    status: '읽기 실패',
    rows: [['5시간', '61%', '4시간 11분 후 초기화'], ['주간', '60%', '6일 0시간 후 초기화']],
    dim: true,
    note: '마지막 정상 값 · 9분 전',
  });
  check('chatgpt: failure detail in the tooltip', $('status_chatgpt').title, detail);
  check('toggles follow enabledProviders', [$('toggle_claude').checked, $('toggle_chatgpt').checked], [true, true]);
  check('gemini: a real provider now, off (not enabled)', card('gemini'), {status: '꺼짐', rows: [], dim: false, note: ''});
  check('gemini toggle enabled and unchecked', [$('toggle_gemini').disabled, $('toggle_gemini').checked], [false, false]);
  check('re-renders every 30 s', timers, [30 * 1000]);
}

console.log('\nstorage changes → the popup re-renders');
{
  await storeAndRender({usage_claude: claudeOk({fiveHour: 0})});
  check('5-hour 0 is "0%", not "?"', rows('claude')[0], ['5시간', '0%', '4시간 20분 후 초기화']);
  await storeAndRender({usage_claude: claudeOk({agoMs: 10 * MIN})});
  check('stale after 6 minutes', card('claude'), {
    status: '오래됨',
    rows: [['5시간', '60%', '4시간 20분 후 초기화'], ['주간', '0%', '20시간 5분 후 초기화']],
    dim: true,
    note: '오래된 값 · 10분 전 확인',
  });
  await storeAndRender({usage_claude: claudeOk()});
  check('fresh again', card('claude').status, '정상');
}

console.log('\nother Chrome profiles');
{
  check('off by default: switch off, how-to note', [$('toggle_peers').checked, $('status_peers').textContent, $('peer_setup').hidden, $('note_peers').textContent], [false, '꺼짐', true, KO.peers_hint]);
  check('experimental: folded away, download and about links ready', [$('labs').open, $('peer_links').hidden, $('peer_get_helper').getAttribute('href'), $('peer_get_helper').getAttribute('rel')],
    [false, false, 'https://github.com/donasman/leeway/releases/latest/download/leeway-helper.exe', 'noopener']);
  $('peer_label').value = '업무용';
  $('toggle_peers').checked = true;
  calls.length = 0;
  $('toggle_peers').dispatchEvent(new globalThis.document.defaultView.Event('change'));
  await settle();
  check('on: asks for nativeMessaging, then background turns it on with the name', calls.filter(c => c[0] !== 'storage.set'), [['permissions.request', ['nativeMessaging']], ['runtime.sendMessage', 'PEERS_ENABLE', '업무용']]);
  check('on, nothing from the helper yet: waiting, name field shown', [$('toggle_peers').checked, $('status_peers').textContent, $('peer_setup').hidden, $('peer_label').value], [true, '대기 중', false, '업무용']);

  const at = new Date(Date.now() - 3 * MIN).toISOString();
  await storeAndRender({peer_profiles: {at, ok: true, error: null, profiles: [{id: 'fedcba9876543210', label: '<b>개인</b>', updated_at: at, snapshots: [
    {provider: 'claude', status: 'ok', collected_at: at, plan: 'Pro', limits: [limit('claude_5h', 0), limit('claude_weekly', 41)]},
  ]}]}});
  const peer = $('peers_list').querySelector('.peer');
  check('another profile: its name as text, when it sent', [peer?.querySelector('.peer-head span')?.textContent, peer?.querySelector('.peer-head .muted')?.textContent, peer?.querySelector('b')], ['<b>개인</b>', '3분 전 갱신', null]);
  check('its service, plan and 0% as 0%', [peer?.querySelector('.peer-name')?.textContent, [...peer.querySelectorAll('.limit .pct')].map(c => c.textContent)], ['Claude · Pro', ['0%', '41%']]);
  check('count of other profiles', [$('status_peers').textContent, $('note_peers').textContent], ['1', '']);
  check('on and connected: section open, links out of the way', [$('labs').open, $('peer_links').hidden], [true, true]);

  await storeAndRender({peer_profiles: {at, ok: false, error: 'helper_missing', profiles: []}});
  check('helper not installed: says how to fix it', [$('status_peers').textContent, $('note_peers').textContent, $('peers_list').children.length], ['읽기 실패', KO.peers_helper_missing, 0]);
  check('helper not installed: the download link is back', $('peer_links').hidden, false);

  $('peer_label').value = '회사';
  calls.length = 0;
  $('peer_label').dispatchEvent(new globalThis.document.defaultView.Event('change'));
  await settle();
  check('renaming sends the new name', calls.filter(c => c[0] === 'runtime.sendMessage'), [['runtime.sendMessage', 'PEERS_LABEL', '회사']]);

  $('toggle_peers').checked = false;
  calls.length = 0;
  $('toggle_peers').dispatchEvent(new globalThis.document.defaultView.Event('change'));
  await settle();
  check('off: background turns it off, no permission prompt', calls.filter(c => c[0] !== 'storage.set'), [['runtime.sendMessage', 'PEERS_DISABLE']]);
  check('off again: hint, list empty', [$('toggle_peers').checked, $('note_peers').textContent, $('peers_list').children.length], [false, KO.peers_hint, 0]);

  permissionAnswer = false;
  $('toggle_peers').checked = true;
  $('toggle_peers').dispatchEvent(new globalThis.document.defaultView.Event('change'));
  await settle();
  check('permission refused: stays off and says why', [$('toggle_peers').checked, $('note_peers').textContent], [false, KO.refused_note]);
  permissionAnswer = true;
}

console.log('\nplan and Claude organizations');
{
  await storeAndRender({usage_claude: {...claudeOk(), plan: 'Max 5x'}});
  check('plan next to the name', $('plan_claude').textContent, 'Max 5x');
  check('rows unchanged with a plan', rows('claude')[0], ['5시간', '60%', '4시간 20분 후 초기화']);
  const main = claudeOk();
  await storeAndRender({usage_claude: {...main, plan: 'Max 5x', accounts: [
    {plan: 'Max 5x', status: 'ok', primary_limit_id: 'claude_5h', limits: main.limits},
    {plan: 'Team', status: 'logged_out', primary_limit_id: null, limits: []},
  ]}});
  const blocks = [...$('limits_claude').children];
  check('one block per organization', blocks.map(b => b.className), ['account', 'account']);
  check('each block named by its plan, status when not ok', blocks.map(b => b.querySelector('.account-name').textContent), ['Max 5x', 'Team로그인 필요']);
  check('the other organization: "?" for no value', [...blocks[1].querySelectorAll('.limit .pct')].map(c => c.textContent), ['?']);
  check('header plan hidden when each block names its own', $('plan_claude').textContent, '');
  await storeAndRender({usage_claude: claudeOk()});
  check('back to one organization: plain rows, no plan', [rows('claude').length, $('plan_claude').textContent], [2, '']);
}

console.log('\nthe clock alone → re-render on the 30-second tick');
{
  store.set('usage_claude', claudeOk({agoMs: 7 * MIN})); // no onChanged
  check('before the tick: unchanged', card('claude').status, '정상');
  await tick();
  check('after the tick: stale', [card('claude').status, card('claude').note], ['오래됨', '오래된 값 · 7분 전 확인']);
  await storeAndRender({usage_claude: claudeOk()});
}

console.log('\nan older render that finishes last does not overwrite a newer one');
{
  let releaseGet;
  getGate = new Promise(resolve => { releaseGet = resolve; });
  const older = tick(); // reads 60% now, delivered after the newer render
  getGate = null;
  store.set('usage_claude', claudeOk({fiveHour: 42}));
  await tick();
  check('newer render shown', rows('claude')[0][1], '42%');
  releaseGet();
  await older;
  check('older render, finishing last, ignored', rows('claude')[0][1], '42%');
  await storeAndRender({usage_claude: claudeOk()});
}

console.log('\ntext from web pages stays text');
{
  const hostile = snapshot('chatgpt', 'ok', [
    limit('chatgpt_5h', 61, {reset_text: '<img src=x onerror="globalThis.pwned=1">'}),
    limit('chatgpt_86400s', 50, {label: '<b>bold</b>'}),
  ], 0);
  await storeAndRender({usage_chatgpt: hostile, usage_last_ok_chatgpt: hostile});
  check('no elements created from stored strings', $('limits_chatgpt').querySelectorAll('img, b').length, 0);
  check('shown literally', rows('chatgpt'), [['5시간', '61%', '<img src=x onerror="globalThis.pwned=1">'], ['<b>bold</b>', '50%', '']]);
  await storeAndRender({usage_chatgpt: chatgptOk(MIN), usage_last_ok_chatgpt: chatgptOk(MIN)});
}

console.log('\nodd stored data for one provider does not blank the others');
{
  const odd = claudeOk({fiveHour: 33});
  odd.limits.unshift(null, 'x');
  await storeAndRender({usage_claude: odd, usage_last_ok_claude: odd});
  check('claude: odd entries skipped, the rest shown', rows('claude').map(r => r[1]), ['33%', '0%']);
  await storeAndRender({usage_claude: {status: 'ok', collected_at: new Date().toISOString(), primary_limit_id: 'claude_5h', limits: 'nope'}});
  check('claude: limits not a list → no rows', rows('claude'), []);
  check('chatgpt still shown', card('chatgpt').status, '정상');
  await storeAndRender({usage_claude: claudeOk(), usage_last_ok_claude: claudeOk()});
}

console.log('\nonly enabled providers show values (CLAUDE.md §2)');
{
  await storeAndRender({enabledProviders: ['chatgpt']});
  check('claude off: nothing shown although its snapshots are stored', card('claude'), {status: '꺼짐', rows: [], dim: false, note: ''});
  check('claude toggle unchecked', $('toggle_claude').checked, false);
  check('chatgpt unaffected', card('chatgpt').status, '정상');
  granted.delete(CHATGPT);
  await storeAndRender({enabledProviders: ['claude', 'chatgpt']});
  check('enabled but permission gone', card('chatgpt'), {status: '권한 필요', rows: [], dim: false, note: '사이트 권한이 없습니다. 껐다 켜서 허용하세요.'});
  granted.add(CHATGPT);
  await tick();
  check('permission back: shown on the next tick', card('chatgpt').status, '정상');
}

console.log('\nturning off — one message; background does the rest');
{
  await clickAndSettle('toggle_claude');
  check('popup only asks', calls, [['runtime.sendMessage', 'PROVIDER_DISABLED']]);
  check('shown as off, unlocked', [card('claude').status, $('toggle_claude').checked, $('toggle_claude').disabled], ['꺼짐', false, false]);
}

console.log('\nturning on — the permission request inside the click (user gesture), then PROVIDER_ENABLED');
{
  permissionAnswer = true;
  calls.length = 0;
  $('toggle_claude').click();
  check('requested before the click handler first waits', calls, [['permissions.request', [CLAUDE]]]);
  await settle();
  check('order', calls, [['permissions.request', [CLAUDE]], ['runtime.sendMessage', 'PROVIDER_ENABLED']]);
  check('waiting for the first refresh', [card('claude').status, card('claude').rows, $('toggle_claude').checked], ['대기 중', [], true]);
}

console.log('\nwhile a toggle is in flight: the checkbox is locked, and renders leave it as clicked');
{
  await clickAndSettle('toggle_claude'); // off again
  let answer;
  requestGate = new Promise(resolve => { answer = resolve; });
  await clickAndSettle('toggle_claude'); // the prompt is open
  check('checked by the user, locked', [$('toggle_claude').checked, $('toggle_claude').disabled], [true, true]);
  await tick();
  check('still checked after a render', $('toggle_claude').checked, true);
  requestGate = null;
  answer();
  await settle();
  check('allowed: on, unlocked', [$('toggle_claude').checked, $('toggle_claude').disabled, card('claude').status], [true, false, '대기 중']);
}

const REFUSED = '사이트 권한을 허용해야 켤 수 있습니다.';
console.log('\nturning on — permission refused');
{
  await clickAndSettle('toggle_claude'); // off again
  permissionAnswer = false;
  await clickAndSettle('toggle_claude');
  check('only the request', calls, [['permissions.request', [CLAUDE]]]);
  check('stays off, says why', [$('toggle_claude').checked, card('claude').status, card('claude').note], [false, '꺼짐', REFUSED]);
  check('still not enabled', store.get('enabledProviders'), ['chatgpt']);
  await storeAndRender({usage_chatgpt: chatgptOk(0), usage_last_ok_chatgpt: chatgptOk(0)});
  await tick();
  check('the note survives later renders', card('claude').note, REFUSED);
  // Allowed afterwards some other way (background's permissions.onAdded): on now, so no refusal note.
  granted.add(CLAUDE);
  await storeAndRender({enabledProviders: ['chatgpt', 'claude']});
  check('turned on meanwhile: the note goes', [card('claude').status, card('claude').note], ['대기 중', '']);
  await clickAndSettle('toggle_claude'); // the user turns it off
  check('the next toggle clears the old refusal', [card('claude').status, card('claude').note], ['꺼짐', '']);
  permissionAnswer = true;
}

console.log('\nrefresh button — waits for REFRESH_ALL');
{
  let release;
  refreshGate = new Promise(resolve => { release = resolve; });
  await clickAndSettle('refresh');
  check('sent', calls, [['runtime.sendMessage', 'REFRESH_ALL']]);
  check('busy while waiting', [$('refresh').disabled, $('refresh').textContent], [true, '확인 중…']);
  release();
  await settle();
  check('back after', [$('refresh').disabled, $('refresh').textContent], [false, '새로고침']);
  refreshGate = null;
}

console.log('\nGemini — a real provider: on, values shown, open-usage button');
{
  granted.add(GEMINI);
  await storeAndRender({enabledProviders: ['chatgpt', 'gemini'], usage_gemini: geminiOk(), usage_last_ok_gemini: geminiOk()});
  check('gemini shown: 현재 사용량(5시간) primary, 주간', card('gemini'), {
    status: '정상',
    rows: [['5시간', '100%', '4시간 20분 후 초기화'], ['주간', '100%', '20시간 5분 후 초기화']],
    dim: false,
    note: '2분 전 확인',
  });
  check('gemini: 5시간 row is the primary one', [...$('limits_gemini').querySelectorAll('.limit.primary .label')].map(cell => cell.textContent), ['5시간']);
  check('gemini toggle checked', $('toggle_gemini').checked, true);
  await clickAndSettle('openGemini');
  check('Gemini 사용량 button asks background to open the usage page', calls, [['runtime.sendMessage', 'OPEN_GEMINI_USAGE']]);
}

console.log('\nGemini — turning on asks for the gemini.google.com permission');
{
  await storeAndRender({enabledProviders: ['chatgpt'], usage_gemini: null, usage_last_ok_gemini: null}); // off, no stored value
  granted.delete(GEMINI);
  permissionAnswer = true;
  calls.length = 0;
  $('toggle_gemini').click();
  check('permission requested in the click (user gesture)', calls, [['permissions.request', [GEMINI]]]);
  await settle();
  check('then PROVIDER_ENABLED', calls, [['permissions.request', [GEMINI]], ['runtime.sendMessage', 'PROVIDER_ENABLED']]);
  check('on, waiting for the first read', [$('toggle_gemini').checked, card('gemini').status, card('gemini').rows], [true, '대기 중', []]);
}

console.log('\noverlay button — injects overlay_inject.js into the active tab');
{
  activeTab = {id: 1, url: 'https://example.com/'};
  await clickAndSettle('openOverlay');
  check('normal web page: injects the overlay, no hint', [calls, $('ovmsg').textContent], [[['scripting.executeScript', ['overlay_inject.js']]], '']);
  activeTab = {id: 2, url: 'chrome://extensions'};
  await clickAndSettle('openOverlay');
  check('chrome:// page: no inject, shows the hint', [calls, $('ovmsg').textContent], [[], KO.overlay_hint]);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
