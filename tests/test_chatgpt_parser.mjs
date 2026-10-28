// Run with: node tests/test_chatgpt_parser.mjs   (once: npm install — jsdom)
//
// extension/chatgpt.js is a content script (IIFE, no exports), so it can't be
// imported. Per CLAUDE.md §5 the source is not copied: the real file is run
// as-is inside a jsdom window, and the result is requested with the same
// SCAN_USAGE message background.js sends.
//
// Limits: jsdom has no innerText, so chatgpt.js reads through its textContent
// fallback. Real Chrome (innerText) puts line breaks between blocks, so text
// boundaries can differ. There is no real layout either. Checking a live page
// stays in overlay-verify's "사용자 확인 필요" list.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const KNOWN = '\x1b[33mKNOWN\x1b[0m';
let passed = 0;
let failed = 0;
let known = 0;

function check(label, got, expected) {
  const ok = Object.is(got, expected);
  const tag = ok ? PASS : FAIL;
  console.log(`  [${tag}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

// A bug we know about and haven't fixed yet. Today `got` differs from
// `expected` (KNOWN, not a failure). Once the bug is fixed and they match,
// this reports FAIL on purpose — move the line to check().
function knownBug(label, got, expected) {
  if (Object.is(got, expected)) {
    console.log(`  [${FAIL}] ${label}: now returns ${JSON.stringify(expected)} — bug fixed? move this line to check()`);
    failed++;
  } else {
    console.log(`  [${KNOWN}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
    known++;
  }
}

const SOURCE = readFileSync(new URL('../extension/chatgpt.js', import.meta.url), 'utf8');
const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const USAGE_URL = 'https://chatgpt.com/#settings/Usage';
const CHAT_URL = 'https://chatgpt.com/c/fixture-conversation';

// One extension load's chrome.*: the onMessage listeners and what it was sent.
function chromeStub() {
  const listeners = [];
  const sent = [];
  return {
    listeners, sent,
    chrome: {
      runtime: {
        onMessage: {addListener: fn => listeners.push(fn), hasListener: fn => listeners.includes(fn)},
        sendMessage: async message => { sent.push(message); },
      },
      storage: {local: {set: async () => {}}},
    },
  };
}

async function scan(html, url = USAGE_URL) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {url, runScripts: 'outside-only'});
  const {window} = dom;
  const {chrome, listeners} = chromeStub();
  window.chrome = chrome;
  try {
    window.eval(SOURCE);
    if (listeners.length !== 1) throw new Error(`expected 1 onMessage listener, got ${listeners.length}`);
    return await new Promise(resolve => listeners[0]({type: 'SCAN_USAGE'}, {}, resolve));
  } finally {
    window.close(); // also clears chatgpt.js's setTimeout(sendNow, 1500)
  }
}

const limit = (payload, id) => (payload.limits || []).find(l => l.id === id);

// ---------------------------------------------------------------------------
// Real capture — Settings > Usage, Korean UI
// ---------------------------------------------------------------------------
console.log('\nreal capture: chatgpt-usage-2026-09-03.html');
{
  const r = await scan(fixture('chatgpt-usage-2026-09-03.html'));
  const p = r.payload;
  check('response ok', r.ok, true);
  check('status', p.status, 'ok');
  check('value = 5-hour remaining', p.value, '61%');
  check('chatgpt_5h remaining_percent', limit(p, 'chatgpt_5h')?.remaining_percent, 61);
  check('chatgpt_5h reset_text', limit(p, 'chatgpt_5h')?.reset_text, '4시간 20분 후 초기화');
  check('chatgpt_5h resets_at (DOM has no absolute time)', limit(p, 'chatgpt_5h')?.resets_at, null);
  check('chatgpt_weekly remaining_percent', limit(p, 'chatgpt_weekly')?.remaining_percent, 60);
  check('chatgpt_weekly reset_text', limit(p, 'chatgpt_weekly')?.reset_text, '6일 0시간 후 초기화');
  check('limits count', p.limits.length, 2);
  check('credits trap: no limit reads 40', p.limits.some(l => l.remaining_percent === 40), false);
  check('legacy detail string (Python overlay)', p.detail,
    '5-hour limit: 61% remaining · 4시간 20분 후 초기화 · weekly limit: 60% remaining · 6일 0시간 후 초기화');
  check('debug.routeDetected', r.debug.routeDetected, true);
  check('debug.failedStep', r.debug.failedStep, 'none');
}

// ---------------------------------------------------------------------------
// 0% — a valid value, never ? or null (CLAUDE.md §1)
// ---------------------------------------------------------------------------
console.log('\nsynthetic: chatgpt-usage-zero-synthetic.html');
{
  const {payload: p} = await scan(fixture('chatgpt-usage-zero-synthetic.html'));
  check('status', p.status, 'ok');
  check('value', p.value, '0%');
  check('chatgpt_5h remaining_percent is 0, not null', limit(p, 'chatgpt_5h')?.remaining_percent, 0);
  check('chatgpt_weekly remaining_percent', limit(p, 'chatgpt_weekly')?.remaining_percent, 60);
}

// ---------------------------------------------------------------------------
// No value — 5-hour card present, its percentage missing
// ---------------------------------------------------------------------------
console.log('\nsynthetic: chatgpt-usage-missing-synthetic.html');
{
  const r = await scan(fixture('chatgpt-usage-missing-synthetic.html'));
  const p = r.payload;
  check('chatgpt_weekly still read', limit(p, 'chatgpt_weekly')?.remaining_percent, 60);
  // Climbing from the 5-hour title stops below the container shared with the
  // weekly card, so the weekly 60% is not taken as the 5-hour value.
  check('value is ? when 5-hour % is missing', p.value, '?');
  check('status is parse_failed', p.status, 'parse_failed');
  check('no chatgpt_5h limit', limit(p, 'chatgpt_5h'), undefined);
  check('debug.failedStep', r.debug.failedStep, '5-hour card found, but its remaining percentage was not found');
}

console.log('\nsynthetic: chatgpt-usage-weekly-missing-synthetic.html');
{
  const {payload: p} = await scan(fixture('chatgpt-usage-weekly-missing-synthetic.html'));
  check('status', p.status, 'ok');
  check('value = 5-hour remaining', p.value, '61%');
  check('chatgpt_5h remaining_percent', limit(p, 'chatgpt_5h')?.remaining_percent, 61);
  check('no chatgpt_weekly limit (the 5-hour 61% is not taken)', limit(p, 'chatgpt_weekly'), undefined);
}

// ---------------------------------------------------------------------------
// English text in the same card layout (inline, not a capture: the English
// screen's wording is unverified). Line breaks stand in for innerText's.
// ---------------------------------------------------------------------------
const englishCard = ({fiveHour, weekly, weeklyReset}) => `
<div class="card">
  <div class="block">
    <div class="head">
      <div>5-hour limit</div>
      <div class="row"><span>Resets in 4 hours 20 minutes</span>
        ${fiveHour === null ? '' : `<span>${fiveHour}% left</span>`}</div>
    </div>
    <div class="bar"></div>
  </div>
  <div class="block">
    <div class="head">
      <div>Weekly limit</div>
      <div class="row"><span>Resets in <button>${weeklyReset}</button></span>
        <span>${weekly}% left</span></div>
    </div>
    <div class="bar"></div>
  </div>
</div>`;

console.log('\ninline: English card, weekly resets in 5 hours');
{
  const {payload: p} = await scan(englishCard({fiveHour: 61, weekly: 60, weeklyReset: '5 hours'}));
  check('chatgpt_5h remaining_percent', limit(p, 'chatgpt_5h')?.remaining_percent, 61);
  check('chatgpt_weekly remaining_percent ("5 hours" is not a 5-hour title)', limit(p, 'chatgpt_weekly')?.remaining_percent, 60);
}
{
  const {payload: p} = await scan(englishCard({fiveHour: null, weekly: 60, weeklyReset: '5 hours'}));
  check('5-hour % missing: value is ?', p.value, '?');
  check('5-hour % missing: no chatgpt_5h limit', limit(p, 'chatgpt_5h'), undefined);
  check('5-hour % missing: chatgpt_weekly still read', limit(p, 'chatgpt_weekly')?.remaining_percent, 60);
}

// ---------------------------------------------------------------------------
// No usage card at all (another page, logged out, ...)
// ---------------------------------------------------------------------------
console.log('\ninline: page without usage cards');
{
  const r = await scan('<main><h1>New chat</h1><p>How can I help you today?</p></main>');
  const p = r.payload;
  check('value', p.value, '?');
  check('status', p.status, 'parse_failed');
  check('limits empty', p.limits.length, 0);
  check('debug.failedStep', r.debug.failedStep, '5-hour limit label was not found');
}

// ---------------------------------------------------------------------------
// Same markup outside Settings > Usage — pins CURRENT parser behavior: the
// value is accepted without the usage screen. Since 2026-10-15 background
// injects only into Settings > Usage tabs (the fallback when the usage API
// fails), so a conversation tab never reaches this. Change on purpose.
// ---------------------------------------------------------------------------
console.log('\ncurrent behavior: usage markup on a conversation URL');
{
  const r = await scan(fixture('chatgpt-usage-2026-09-03.html'), CHAT_URL);
  check('debug.routeDetected', r.debug.routeDetected, false);
  check('debug.failedStep', r.debug.failedStep, 'Settings > Usage route/dialog was not detected');
  check('value still accepted (current)', r.payload.value, '61%');
  check('status still ok (current)', r.payload.status, 'ok');
}

// ---------------------------------------------------------------------------
// Injection. background injects chatgpt.js into an already open Settings >
// Usage tab only when the usage API fails (CLAUDE.md §2).
// ---------------------------------------------------------------------------
console.log('\ninjection: one listener per extension load, no reporting of its own');
{
  const dom = new JSDOM(`<!doctype html><html><body>${fixture('chatgpt-usage-2026-09-03.html')}</body></html>`, {url: USAGE_URL, runScripts: 'outside-only'});
  const {window} = dom;
  const timers = [];
  const windowEvents = [];
  window.setTimeout = (_fn, ms) => { timers.push(ms); return 0; };
  const addEventListener = window.addEventListener.bind(window);
  window.addEventListener = (type, ...rest) => { windowEvents.push(type); return addEventListener(type, ...rest); };
  const first = chromeStub();
  window.chrome = first.chrome;
  window.eval(SOURCE);
  window.eval(SOURCE); // injected again while this copy still listens
  check('injected twice in one load: one listener', first.listeners.length, 1);
  check('no timer (no report on load)', timers.length, 0);
  check('no window listener (no report on tab focus)', windowEvents.length, 0);
  check('sends nothing by itself', first.sent.length, 0);
  // The extension is reloaded: the old copy stays in the page, its runtime gone.
  const second = chromeStub();
  window.chrome = second.chrome;
  window.eval(SOURCE);
  check('after a reload, injected again: listens on the new runtime', second.listeners.length, 1);
  const r = await new Promise(resolve => second.listeners[0]({type: 'SCAN_USAGE'}, {}, resolve));
  check('...and answers', `${r.payload.status} ${r.payload.value}`, 'ok 61%');
  window.close();
}
{
  // Copies from before 2026-10-15 marked the page with `true`.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: USAGE_URL, runScripts: 'outside-only'});
  const stub = chromeStub();
  dom.window.chrome = stub.chrome;
  dom.window.__llmUsageOverlayChatGPT = true;
  dom.window.eval(SOURCE);
  check('an older copy\'s `true` mark does not block', stub.listeners.length, 1);
  dom.window.close();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed + known} checks — ${passed} passed, ${failed} failed, ${known} known bugs`);
if (failed > 0) process.exit(1);
