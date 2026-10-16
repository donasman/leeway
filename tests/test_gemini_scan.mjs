// Run with: node tests/test_gemini_scan.mjs   (needs jsdom — run `npm install` once)
//
// Runs the real extension/gemini_scan.js content script in jsdom (never a copy,
// CLAUDE.md §5) against a reconstruction of the 2026-10-15 gemini.google.com/usage
// page: hashed class names, so cards are section elements found by their label
// text; "N% 사용됨" in a <strong>, the reset wording in a <span>; a sidebar whose
// chat titles can collide with a card label. It checks that the script pulls the
// right card text, waits for a late render, and never keeps page/chat text.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const SCRIPT = readFileSync(new URL('../extension/gemini_scan.js', import.meta.url), 'utf8');

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  [${ok ? PASS : FAIL}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

const CHAT = 'chat title secret';
function pageHtml(variant) {
  const current = variant === 'values' ? '37' : '0';
  const weekly = variant === 'values' ? '12.5' : '0';
  const currentPct = variant === 'no-current-pct' ? '' : `<div class="x1a2a7pz"><strong class="x1ghz6dp">${current}% 사용됨</strong></div>`;
  const weeklyReset = variant === 'no-weekly-reset' ? '' : '<span class="x1ghz6dp">10월 16일 오후 4:19에 초기화</span>';
  const cards = `<section class="x1a2a7pz"><div class="x1a2a7pz">
    <section class="x1a2a7pz">
      <div class="x1a2a7pz"><div class="x9f619"><span>현재 사용량</span><span role="img">i</span><span class="x0tip" style="display:none">현재 사용량은 5시간마다 초기화됩니다</span></div>${currentPct}</div>
      <div class="x9f619"><div class="xeuugli" style="width:${current}%"></div></div>
      <div class="x1a2a7pz"><span class="x1ghz6dp">오후 10:19에 초기화</span></div>
    </section>
    <section class="x1a2a7pz">
      <div class="x1a2a7pz"><span class="x1a2a7pz"><span>주간 한도</span>${weeklyReset}</span></div>
      <div class="x1a2a7pz"><strong class="x1ghz6dp">${weekly}% 사용됨</strong></div>
    </section>
  </div></section>`;
  // A hidden, stale copy of the current card that must be ignored (display:none).
  const hidden = variant === 'hidden' ? '<div style="display:none"><span>현재 사용량</span><strong>50% 사용됨</strong><span>오전 1:00에 초기화</span></div>' : '';
  const main = `<div class="x1a2a7pz"><h2>사용량 한도</h2><p>요금제의 한도에 따라 Gemini를 사용할 수 있는 시간이 결정됩니다.</p><p>1시간 전에 업데이트됨</p>${hidden}${cards}
    <div><p>AI Plus(으)로 사용량 2배 늘리기</p><button>업그레이드</button></div></div>`;
  // The sidebar has a conversation titled exactly like a card label, plus a real chat.
  const nav = `<nav><a>주간 한도</a><a>${CHAT}</a></nav>`;
  const body = variant === 'delayed' || variant === 'empty' ? '<main id="m"></main>' : `<main id="m">${main}</main>`;
  return `${nav}${body}`;
}

async function runVariant(variant, {timeoutMs, inject, twice} = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${pageHtml(variant)}</body></html>`, {url: 'https://gemini.google.com/usage', runScripts: 'outside-only'});
  const { window } = dom;
  // innerText stand-in with block line breaks (jsdom has none); visibleText
  // guards display:none via getComputedStyle before ever reading this.
  const inner = node => (node.nodeType === 3 ? node.textContent : [...node.childNodes].map(inner).filter(s => s.trim()).join('\n'));
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {get() { return inner(this); }, configurable: true});
  const listeners = [];
  window.chrome = {runtime: {onMessage: {addListener: fn => listeners.push(fn), hasListener: fn => listeners.includes(fn)}}};
  if (timeoutMs) window.__llmGeminiScanTimeoutMs = timeoutMs;
  if (inject) window.setTimeout(() => { window.document.getElementById('m').innerHTML = pageHtml('live').replace(/^<nav>.*<\/nav>/, '').replace('<main id="m">', '').replace('</main>', ''); }, inject);

  window.eval(SCRIPT);
  if (twice) window.eval(SCRIPT); // a second injection must not add a second listener
  const handler = window.__llmUsageOverlayGemini;
  const response = await new Promise((resolve, reject) => {
    const kept = handler({type: 'SCAN_GEMINI'}, {}, resolve);
    if (kept !== true) reject(new Error('listener did not keep the channel open for the async reply'));
  });
  return {response, listeners, serialized: JSON.stringify(response)};
}

console.log('\nboth cards on the page (2026-10-15 structure)');
{
  const {response, serialized} = await runVariant('live');
  check('ok', response.ok, true);
  check('current card raw strings', response.cards.current, {used: '0% 사용됨', reset: '오후 10:19에 초기화'});
  check('weekly card raw strings', response.cards.weekly, {used: '0% 사용됨', reset: '10월 16일 오후 4:19에 초기화'});
  check('updated text', response.updated, '1시간 전에 업데이트됨');
  check('debug: no failure, both found', [response.debug.failedStep, response.debug.currentFound, response.debug.weeklyFound], ['none', true, true]);
  check('debug url: origin + path only', response.debug.url, 'https://gemini.google.com/usage');
  check('no conversation title kept anywhere', serialized.includes(CHAT), false);
}

console.log('\nvalues (used %, not remaining — gemini.js inverts)');
{
  const {response} = await runVariant('values');
  check('current 37% used', response.cards.current.used, '37% 사용됨');
  check('weekly 12.5% used', response.cards.weekly.used, '12.5% 사용됨');
}

console.log('\nsidebar chat titled like a card label is not mistaken for the card');
{
  const {response} = await runVariant('live');
  // The <nav> "주간 한도" link has no %/reset near it, so the real weekly card wins.
  check('weekly from the card, not the nav link', response.cards.weekly, {used: '0% 사용됨', reset: '10월 16일 오후 4:19에 초기화'});
}

console.log('\nhidden (display:none) stale card is ignored');
{
  const {response} = await runVariant('hidden');
  check('reads the visible 0%, not the hidden 50%', response.cards.current.used, '0% 사용됨');
}

console.log('\nlate render: waits for the cards, then reads them');
{
  const {response} = await runVariant('delayed', {timeoutMs: 2000, inject: 150});
  check('current read after the wait', response.cards.current, {used: '0% 사용됨', reset: '오후 10:19에 초기화'});
  check('weekly read after the wait', response.cards.weekly?.used, '0% 사용됨');
  check('waited for it (>= ~150ms, well under the 2s cap)', response.debug.waitedMs >= 120 && response.debug.waitedMs < 2000, true);
}

console.log('\ncurrent card found but without its % → gemini_5h unreadable');
{
  const {response} = await runVariant('no-current-pct', {timeoutMs: 300});
  check('current used null, reset still read', response.cards.current, {used: null, reset: '오후 10:19에 초기화'});
  check('weekly still read', response.cards.weekly?.used, '0% 사용됨');
  check('failedStep names it', response.debug.failedStep, 'current-usage card found, but no "% 사용됨"');
}

console.log('\nweekly card without a reset → null reset, current unaffected');
{
  const {response} = await runVariant('no-weekly-reset', {timeoutMs: 300});
  check('weekly reset null, used kept', response.cards.weekly, {used: '0% 사용됨', reset: null});
  check('current unaffected', response.cards.current, {used: '0% 사용됨', reset: '오후 10:19에 초기화'});
  check('no failure (current is readable)', response.debug.failedStep, 'none');
}

console.log('\nno cards at all (signed out / wrong page)');
{
  const {response} = await runVariant('empty', {timeoutMs: 300});
  check('both null', [response.cards.current, response.cards.weekly], [null, null]);
  check('updated null', response.updated, null);
  check('failedStep: cards not found', response.debug.failedStep, 'usage cards not found');
}

console.log('\nguard: a second injection does not add a second listener');
{
  const {listeners} = await runVariant('live', {twice: true});
  check('one listener only', listeners.length, 1);
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
