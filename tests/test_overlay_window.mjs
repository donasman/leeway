// Run with: node tests/test_overlay_window.mjs
//
// Loads the real extension/overlay_window.html into jsdom and imports the real
// overlay_window.js (no copied source, CLAUDE.md §5) with an in-memory chrome.*
// stub and a stand-in for Document Picture-in-Picture whose window is another
// jsdom document. Covers the Leeway window (CLAUDE.md §4): what it shows, the
// "Always on top" button (one PiP, this window minimized), closing the PiP
// (this window comes back), new values reaching both, and where the window is
// left. What the overlay draws is test_overlay.mjs; opening the window is
// test_background.mjs.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { toSnapshot } from '../extension/snapshot.js';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  [${ok ? PASS : FAIL}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

const html = readFileSync(new URL('../extension/overlay_window.html', import.meta.url), 'utf8');
const KO = Object.fromEntries(Object.entries(
  JSON.parse(readFileSync(new URL('../extension/_locales/ko/messages.json', import.meta.url), 'utf8')),
).map(([key, value]) => [key, value.message]));
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };

// Stored the way publish() stores them: made by the real toSnapshot().
const MIN = 60 * 1000;
const CLAUDE = 'https://claude.ai/*';
const limit = (id, remaining_percent) => ({id, label: id, remaining_percent, resets_at: null, reset_text: null});
const claudeOk = (fiveHour, agoMs = 2 * MIN) => ({
  ...toSnapshot({provider: 'claude', status: 'ok', value: '', detail: '', limits: [limit('claude_5h', fiveHour), limit('claude_weekly', 0)]}, Date.now() - agoMs),
  plan: 'Max 5x',
});
const claudeOn = (snapshot = claudeOk(72)) => ({enabledProviders: ['claude'], usage_claude: snapshot, usage_last_ok_claude: snapshot});

// ---- chrome.* stub ---------------------------------------------------------

const store = new Map();
const granted = new Set();
let changeListeners = [];
let boundsListeners = [];
const calls = [];
let reads = 0; // storage.local.get() calls: each refresh reads
let ownWindow = {id: 42, type: 'popup', state: 'normal'};

// Like Chrome: onChanged comes later, only for values that changed.
function write(items) {
  const changes = {};
  for (const [key, value] of Object.entries(items)) {
    if (JSON.stringify(store.get(key)) === JSON.stringify(value)) continue;
    changes[key] = {oldValue: store.get(key), newValue: value};
    store.set(key, structuredClone(value));
  }
  if (Object.keys(changes).length) setImmediate(() => changeListeners.forEach(fn => fn(changes, 'local')));
}
function storeOnly(items) { store.clear(); for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value)); }

globalThis.chrome = {
  i18n: {getMessage: key => KO[key] ?? '', getUILanguage: () => 'ko'},
  // The window asks background for nothing; a call would show up here.
  runtime: {async sendMessage(message) { calls.push(['runtime.sendMessage', message?.type]); }},
  permissions: {async contains({origins = []}) { return origins.every(origin => granted.has(origin)); }},
  storage: {
    local: {
      async get(keys) { reads += 1; return Object.fromEntries([].concat(keys).filter(k => store.has(k)).map(k => [k, structuredClone(store.get(k))])); },
      async set(items) { calls.push(['storage.set', structuredClone(items)]); write(items); },
    },
    onChanged: {addListener: fn => changeListeners.push(fn)},
  },
  windows: {
    async getCurrent() { return structuredClone(ownWindow); },
    async update(windowId, props) { calls.push(['windows.update', windowId, props]); return {id: windowId}; },
    onBoundsChanged: {addListener: fn => boundsListeners.push(fn)},
  },
};
// The page's global is its window, as in Chrome.
globalThis.window = globalThis;

// Document Picture-in-Picture: requestWindow() hands back a jsdom window and
// makes it documentPictureInPicture.window, as Chrome does, until it closes.
let pipDom = null;
const requests = [];
let refuse = false;
const dpip = {
  window: null,
  async requestWindow(options) {
    requests.push(options);
    if (refuse) throw new DOMException('no', 'NotAllowedError');
    pipDom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    Object.assign(pipDom.window, {outerHeight: 270, innerHeight: 240, resizeTo() {}});
    dpip.window = pipDom.window;
    return pipDom.window;
  },
};
const closePip = async () => { const win = dpip.window; dpip.window = null; win.dispatchEvent(new win.Event('pagehide')); await settle(); };

// A fresh overlay_window.html + overlay_window.js, as when background opens
// the window. The previous one counts as closed: its listeners are dropped.
// The 30-second timer is captured instead of started; tick() runs it.
let tick = null;
async function openWindow(tag, {pip = true} = {}) {
  globalThis.document = new JSDOM(html).window.document;
  changeListeners = [];
  boundsListeners = [];
  calls.length = 0;
  requests.length = 0;
  dpip.window = null;
  if (pip) globalThis.documentPictureInPicture = dpip;
  else delete globalThis.documentPictureInPicture;
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { timers.push({fn, ms}); return timers.length; };
  try { await import(`../extension/overlay_window.js?open=${tag}`); }
  finally { globalThis.setInterval = realSetInterval; }
  const timer = timers.find(t => t.ms === 30 * 1000);
  tick = async () => { await timer.fn(); await settle(); };
  await settle();
  return timers.map(t => t.ms);
}

const $ = id => globalThis.document.getElementById(id);
const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const bigs = doc => [...doc.querySelectorAll('#ov .big')].map(text);
const pipDoc = () => pipDom.window.document;
const pinClick = async () => { calls.length = 0; $('pin').click(); await settle(); };
const changed = async (keys, area = 'local') => { reads = 0; changeListeners.forEach(fn => fn(Object.fromEntries(keys.map(k => [k, {}])), area)); await settle(); };
const checkedAgo = minutes => KO.checked.replace('{age}', KO.ago.replace('{age}', `${minutes}${KO.unit_minute}`));

// ---------------------------------------------------------------------------
console.log('\nthe window — the expanded overlay, the button above it, one line below');
{
  storeOnly(claudeOn(claudeOk(72)));
  granted.add(CLAUDE);
  check('a 30-second timer keeps "N min ago" current', await openWindow('shows'), [30 * 1000]);
  check('texts in the UI language', [$('pin').textContent, text(globalThis.document.querySelector('.note')), globalThis.document.documentElement.lang], [KO.overlay_pin, KO.overlay_window_note, 'ko']);
  check('values read from storage here: nothing asked of background', calls.filter(c => c[0] === 'runtime.sendMessage'), []);
  check('expanded: header and one block per service, 0% stays 0%', [text($('ov').querySelector('.brand')), text($('ov').querySelector('.name > span')), bigs(globalThis.document), text($('ov').querySelector('.sub b'))], ['Leeway', 'Claude', ['72%'], '0%']);
  check('header: when the newest value was read', text($('ov').querySelector('.hd .muted')), checkedAgo(2));
  check("the overlay's own style comes first, the window's after it", [...globalThis.document.head.querySelectorAll('style')].map(s => s.textContent.includes('#ov .prov{')), [true, false]);
  $('ov').dispatchEvent(new globalThis.document.defaultView.MouseEvent('click', {bubbles: true}));
  await settle();
  check('a click on the window does not collapse it (only the PiP does)', $('ov').className, '');
  check('nothing opened by itself, the window left as it is', [requests.length, calls.filter(c => c[0] === 'windows.update')], [0, []]);
}

console.log('\n"Always on top" — one PiP, then this window steps aside');
{
  await openWindow('pin');
  await pinClick();
  check('requestWindow once, at the overlay size', requests, [{width: 280, height: 270, preferInitialWindowPlacement: true}]);
  check('the PiP shows what the window shows', pipDoc().getElementById('ov').innerHTML, $('ov').innerHTML);
  check('once it is open, this window minimizes', calls, [['windows.update', 42, {state: 'minimized'}]]);

  await pinClick();
  check('pressed again while it is open: no second requestWindow, minimized again', [requests.length, calls], [1, [['windows.update', 42, {state: 'minimized'}]]]);

  calls.length = 0;
  await closePip();
  check('PiP closed (its X, "back to tab", or Chrome): this window comes back', calls, [['windows.update', 42, {state: 'normal', focused: true}]]);
  await pinClick();
  check('and the button opens a new one', [requests.length, calls.at(-1)], [2, ['windows.update', 42, {state: 'minimized'}]]);
}

console.log('\n"Always on top" — the PiP opens as tall as what this window shows');
{
  storeOnly(claudeOn(claudeOk(72)));
  await openWindow('height');
  // jsdom has no layout: a measured #ov is 30 + 60 per service block.
  Object.defineProperty(globalThis.document.defaultView.HTMLElement.prototype, 'scrollHeight', {configurable: true, get() {
    return this.id === 'ov' ? 30 + 60 * this.querySelectorAll('.prov').length : 0;
  }});
  await pinClick();
  check('measured in this page before opening: one service, so the 140 minimum', requests, [{width: 280, height: 140, preferInitialWindowPlacement: true}]);
  check('this window keeps one #ov, still showing the values', [globalThis.document.querySelectorAll('#ov').length, bigs(globalThis.document)], [1, ['72%']]);
  await closePip();
}

console.log('\n"Always on top" — Chrome refuses, has no Document PiP, or this is a tab');
{
  await openWindow('refused');
  refuse = true;
  await pinClick();
  refuse = false;
  check('requestWindow refused: this window stays as it is', [requests.length, calls], [1, []]);

  await openWindow('old-chrome', {pip: false});
  check('Chrome before 116 (no Document PiP): no button, the window still shows the values', [$('pin').hidden, bigs(globalThis.document)], [true, ['72%']]);

  ownWindow = {id: 9, type: 'normal', state: 'normal'};
  await openWindow('in-a-tab');
  await pinClick();
  check('the page in an ordinary tab: the PiP opens, that browser window is not minimized', [requests.length, calls], [1, []]);
  await closePip();
  check('...nor brought back', calls, []);
  ownWindow = {id: 42, type: 'popup', state: 'normal'};
}

console.log('\nnew values — the window and the PiP both');
{
  storeOnly(claudeOn(claudeOk(72)));
  await openWindow('values');
  await pinClick();
  pipDoc().getElementById('ov').dispatchEvent(new pipDom.window.MouseEvent('click', {bubbles: true})); // collapse the PiP
  await settle();
  const fresh = claudeOk(15, 0);
  write({usage_claude: fresh, usage_last_ok_claude: fresh}); // background saved a new read
  await settle();
  check('the window shows it', bigs(globalThis.document), ['15%']);
  check('the PiP shows it, still collapsed', [pipDoc().getElementById('ov').className, text(pipDoc().querySelector('.ci b'))], ['compact', '15%']);
  await changed(['overlay_window_bounds']);
  await changed(['usage_claude'], 'session');
  check('other keys and other areas: not read again', reads, 0);
  const zero = claudeOk(0, 0);
  store.set('usage_claude', zero); // no change event: only the clock tick sees it
  store.set('usage_last_ok_claude', zero);
  await tick();
  check('the clock tick reads too, and both follow; 0% stays 0%', [bigs(globalThis.document), text(pipDoc().querySelector('.ci b'))], [['0%'], '0%']);
  check('nothing asked of background', calls.filter(c => c[0] === 'runtime.sendMessage'), []);
}

console.log('\nstale (CLAUDE.md §4) — the age comes from the clock at each paint, not from counting ticks');
{
  storeOnly(claudeOn(claudeOk(72, 5 * MIN))); // read 5 minutes ago: not stale yet
  await openWindow('stale');
  await pinClick();
  const prov = doc => doc.querySelector('#ov .prov');
  check('5 minutes old: plain, no chip', [prov(globalThis.document).classList.contains('dim'), prov(globalThis.document).querySelector('.chip')], [false, null]);
  // Nothing refreshed for two more minutes and nothing written: one late tick.
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * MIN;
  try { await tick(); } finally { Date.now = realNow; }
  const shown = doc => [prov(doc).classList.contains('dim'), text(prov(doc).querySelector('.chip')), text(doc.querySelector('#ov .hd .muted'))];
  check('7 minutes: the window shows it stale, with its age', shown(globalThis.document), [true, KO.status_stale, checkedAgo(7)]);
  check('...and so does the PiP', shown(pipDoc()), [true, KO.status_stale, checkedAgo(7)]);
}

console.log('\nvalues — built the way the popup builds them');
{
  const main = claudeOk(60);
  storeOnly(claudeOn({...main, accounts: [
    {plan: 'Max 20x', status: 'ok', primary_limit_id: 'claude_5h', limits: main.limits},
    {plan: 'Team', status: 'ok', primary_limit_id: 'claude_5h', limits: [limit('claude_5h', 10), limit('claude_weekly', 80)]},
    {plan: 'Pro', status: 'logged_out', primary_limit_id: null, limits: []},
  ]}));
  await openWindow('accounts');
  check('Claude organizations: a block each, named by plan; "?" where none was read; ChatGPT (off) left out',
    [...$('ov').querySelectorAll('.prov')].map(b => [text(b.querySelector('.name > span')), text(b.querySelector('.plan')), text(b.querySelector('.big')) ?? '?']),
    [['Claude', 'Max 20x', '60%'], ['Claude', 'Team', '10%'], ['Claude', 'Pro', '?']]);

  const at = new Date(Date.now() - 3 * MIN).toISOString();
  storeOnly({...claudeOn(claudeOk(72)), peer_settings: {on: true, id: '0123456789abcdef', label: ''}, peer_profiles: {at, ok: true, error: null, version: '0.6.3', profiles: [
    {id: 'fedcba9876543210', label: '<b>개인</b>', updated_at: at, snapshots: [{provider: 'claude', status: 'ok', collected_at: at, plan: 'Pro', limits: [limit('claude_5h', 0)]}]},
  ]}});
  await openWindow('peers');
  const peer = $('ov').querySelector('.peer');
  check('another profile: its name as text, its plan, 0% as 0%', [text(peer?.querySelector('.peerh > span')), text(peer?.querySelector('.plan')), text(peer?.querySelector('.big')), $('ov').querySelector('.peer b:not(.bad):not(.warn):not(.good)')], ['<b>개인</b>', 'Pro', '0%', null]);
  write({peer_settings: {on: false, id: '0123456789abcdef', label: ''}});
  await settle();
  check('turned off: no other profiles', $('ov').querySelector('.peer'), null);

  granted.clear();
  storeOnly(claudeOn(claudeOk(72)));
  await openWindow('no-grant');
  check('Claude on without the claude.ai grant: says so, no number', [text($('ov').querySelector('.chip')), bigs(globalThis.document)], [KO.status_needs_permission, []]);
  granted.add(CLAUDE);
}

console.log('\nwhere the window is left — saved for the next time it opens');
{
  await openWindow('bounds');
  const moved = async win => { calls.length = 0; boundsListeners.forEach(fn => fn(win)); await settle(); };
  await moved({id: 42, type: 'popup', state: 'normal', left: 1200, top: 80, width: 330, height: 500});
  check('moved or resized: its place and size saved', calls, [['storage.set', {overlay_window_bounds: {left: 1200, top: 80, width: 330, height: 500}}]]);
  await moved({id: 42, type: 'popup', state: 'minimized', left: -32000, top: -32000, width: 160, height: 28});
  await moved({id: 42, type: 'popup', state: 'maximized', left: 0, top: 0, width: 1920, height: 1040});
  await moved({id: 7, type: 'normal', state: 'normal', left: 0, top: 0, width: 800, height: 600});
  check('minimized, maximized, or another window: nothing saved', calls, []);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
