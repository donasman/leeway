// Run with: node tests/test_overlay.mjs
//
// extension/overlay_view.js — what the overlay draws — opening its Document
// Picture-in-Picture window the way the Leeway window does (overlay_window.js,
// tested in test_overlay_window.mjs). Here the PiP window is a jsdom document
// and the values are fixed, so what is checked is the rendering: expanded (one
// block per service) and collapsed (one ring per service), 0% vs "?", stale,
// Claude organizations, other profiles, that text from storage is never
// markup, and the window sizes.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  [${ok ? PASS : FAIL}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

const KO = Object.fromEntries(Object.entries(
  JSON.parse(readFileSync(new URL('../extension/_locales/ko/messages.json', import.meta.url), 'utf8')),
).map(([key, value]) => [key, value.message]));
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };

globalThis.chrome = {i18n: {getMessage: key => KO[key] ?? ''}};
const { openPip } = await import('../extension/overlay_view.js');
const { toneOf } = await import('../extension/view.js');

// Opens the overlay with `data` drawn in it, as the "Float on top" click does.
// `win`: the PiP window's sizes. jsdom has no layout, so `measured(el)`, when
// given, says how big a drawn #ov is ([scrollWidth, scrollHeight]).
async function openOverlay(data, win = {}, measured = null) {
  const pip = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const resizes = [];
  const requests = [];
  Object.assign(pip.window, {outerHeight: 270, innerHeight: 240, ...win, resizeTo: (w, h) => resizes.push([w, h])});
  if (measured) {
    ['scrollWidth', 'scrollHeight'].forEach((prop, i) => Object.defineProperty(pip.window.HTMLElement.prototype, prop, {configurable: true, get() {
      return this.id === 'ov' ? measured(this)[i] : 0;
    }}));
  }
  const opened = await openPip({window: null, requestWindow: async options => { requests.push(options); return pip.window; }}, structuredClone(data));
  await settle();
  const root = pip.window.document.getElementById('ov');
  return {pip, root, resizes, requests,
    click: async () => { root.dispatchEvent(new pip.window.MouseEvent('click', {bubbles: true})); await settle(); },
    show: async next => { opened.show(structuredClone(next)); await settle(); },
    // The user dragging the window's border to width × height.
    resize: async (width, height) => { Object.assign(pip.window, {innerWidth: width, innerHeight: height}); pip.window.dispatchEvent(new pip.window.Event('resize')); await settle(); }};
}

// Rows as view.js makes them. These are left percentages, so the tone (from
// what is left) follows the number; "used" rows are in their own section.
const row = (label, percent, reset = '', primary = false) => ({label, percent, tone: toneOf(parseInt(percent, 10)), reset, primary});
const provider = (name, extra) => ({provider: name, enabled: true, state: 'ok', status: '정상', dim: false, note: '', plan: null, accounts: [], rows: [], ...extra});
const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

const DATA = {
  checked: '2분 전 확인',
  providers: [
    provider('claude', {plan: 'Max 5x', rows: [row('5시간', '72%', '2시간 48분 후 초기화', true), row('주간', '41%')]}),
    provider('chatgpt', {plan: 'Free', rows: [row('월간', '0%', '10/30 (금) 09:00 초기화', true)]}),
    provider('gemini', {state: 'stale', status: '오래됨', dim: true, note: '오래된 값 · 8분 전 확인', rows: [row('5시간', '?', '', true), row('주간', '80%')]}),
  ],
  peers: [],
};
const ORGS = {checked: '', providers: [
  provider('claude', {rows: [row('5시간', '60%', '', true)], accounts: [
    {label: 'Max 20x', state: 'ok', status: '정상', rows: [row('5시간', '60%', '', true), row('주간', '0%')]},
    {label: 'Team', state: 'logged_out', status: '로그인 필요', rows: [row('5시간', '?', '', true)]},
  ]}),
  provider('chatgpt', {enabled: false, state: 'off', status: '꺼짐'}),
  provider('gemini', {state: 'waiting', status: '대기 중', note: ''}),
], peers: []};
const PEERS = {checked: '', providers: [provider('claude', {rows: [row('5시간', '50%', '', true)]})], peers: [
  {id: 'fedcba9876543210', label: '<img src=x onerror=alert(1)>', updated: '3분 전 갱신', providers: [
    provider('claude', {plan: '<b>Pro</b>', rows: [row('5시간', '0%', '<i>soon</i>', true)]}),
  ]},
]};
const NOTHING = {checked: '', providers: [provider('claude', {enabled: false, state: 'off'})], peers: []};

console.log('\nexpanded — one block per service');
{
  const {root, resizes, requests} = await openOverlay(DATA);
  // Without preferInitialWindowPlacement Chrome reopens a PiP window at the
  // size and place it last had (e.g. one the user dragged bigger), and the
  // width/height asked for are not used (MDN, requestWindow()).
  check('opened at its own size, not the last one Chrome remembers', requests, [{width: 280, height: 270, preferInitialWindowPlacement: true}]);
  // requestWindow() spends the click's activation; resizeTo() after it is
  // refused (NotAllowedError, measured), so the opening size is all there is.
  check('on open, no resizeTo', resizes, []);
  const blocks = [...root.querySelectorAll('.prov')];
  check('header: brand and when it was read', [text(root.querySelector('.brand')), text(root.querySelector('.hd .muted'))], ['Leeway', '2분 전 확인']);
  check('one block per service that is on', blocks.map(b => text(b.querySelector('.name > span'))), ['Claude', 'ChatGPT', 'Gemini']);
  check('plan beside the name', blocks.map(b => text(b.querySelector('.plan'))), ['Max 5x', 'Free', null]);
  check('big main value, coloured by what is left', blocks.map(b => [text(b.querySelector('.big')), b.querySelector('.big').className]), [['72%', 'big good'], ['0%', 'big bad'], ['?', 'big ']]);
  check('bar width follows the main value; "?" is an empty bar', blocks.map(b => b.querySelector('.bar i').getAttribute('style')), ['width:72%', 'width:0%', 'width:0%']);
  check('under it: main limit and reset · the other limits', blocks.map(b => [...b.querySelectorAll('.sub > span')].map(text)),
    [['5시간 · 2시간 48분 후 초기화', '주간 41%'], ['월간 · 10/30 (금) 09:00 초기화', ''], ['5시간', '주간 80%']]);
  check('stale: dimmed, status chip, its note', [blocks[2].classList.contains('dim'), text(blocks[2].querySelector('.chip')), text(blocks[2].querySelector('.muted'))], [true, '오래됨', '오래된 값 · 8분 전 확인']);
  check('an ok service has no chip', blocks.slice(0, 2).map(b => b.querySelector('.chip')), [null, null]);
}

console.log('\nexpanded — services that are off, waiting, several Claude organizations');
{
  const {root} = await openOverlay(ORGS);
  const blocks = [...root.querySelectorAll('.prov')];
  check('organizations: one Claude block each, named by plan; off service left out', blocks.map(b => [text(b.querySelector('.name > span')), text(b.querySelector('.plan'))]),
    [['Claude', 'Max 20x'], ['Claude', 'Team'], ['Gemini', null]]);
  check('an organization that failed says so', text(blocks[1].querySelector('.chip')), '로그인 필요');
  check('weekly 0% in an organization stays 0%, red', blocks[0].querySelector('.sub b')?.outerHTML, '<b class="bad">0%</b>');
  check('waiting: name and chip, no number', [text(blocks[2].querySelector('.chip')), blocks[2].querySelector('.big')], ['대기 중', null]);
}

console.log('\nexpanded — other Chrome profiles, and text is never markup');
{
  const {root} = await openOverlay(PEERS);
  const peer = root.querySelector('.peer');
  check('a section per profile: its name and when it sent', [text(peer?.querySelector('.peerh > span')), text(peer?.querySelector('.peerh .muted'))], ['<img src=x onerror=alert(1)>', '3분 전 갱신']);
  check('its services as blocks', [text(peer?.querySelector('.name > span')), text(peer?.querySelector('.big'))], ['Claude', '0%']);
  check('no markup from storage turned into elements', [root.querySelector('img'), root.querySelector('.plan b'), root.querySelector('.sub i')], [null, null, null]);
}

console.log('\nnothing on');
{
  const {root} = await openOverlay(NOTHING);
  check('says to turn a service on', text(root.querySelector('.empty')), KO.overlay_empty);
}

console.log('\ncollapsed — one ring per service');
{
  const {root, resizes, click} = await openOverlay(DATA);
  await click();
  const items = [...root.querySelectorAll('.ci')];
  check('collapsed: a strip, no service blocks', [root.className, root.querySelectorAll('.prov').length], ['compact', 0]);
  check('name and main value per service; 0% stays 0%', items.map(i => [text(i.querySelector('span')), text(i.querySelector('b'))]), [['Claude', '72%'], ['ChatGPT', '0%'], ['Gemini', '?']]);
  check('a ring arc for a value, none for "?"', items.map(i => i.querySelectorAll('circle').length), [2, 2, 1]);
  check('low values coloured, plenty stays plain', items.map(i => i.querySelector('b').className), ['', 'bad', '']);
  check('stale stays dimmed', items[2].classList.contains('dim'), true);
  check('the strip could not be measured here (jsdom): three services wide, 58 of content (the least resizeTo gives) plus the title bar (30)', resizes.at(-1), [360, 88]);
  await click();
  check('click again: expanded, 280 wide', [root.className, root.querySelectorAll('.prov').length, resizes.at(-1)[0]], ['', 3, 280]);
  check('content not measured (jsdom): three services\' worth, 270 + 30 title bar', resizes.at(-1)[1], 300);
}

console.log('\nused — the numbers turn, the colours stay with what is left (CLAUDE.md §4)');
{
  const used = (label, percent, left, primary = false) => ({label, percent, tone: toneOf(left), reset: '', primary});
  const USED = {checked: '2분 전 확인', mode: 'used', peers: [], providers: [
    provider('claude', {rows: [used('5시간', '28%', 72, true), used('주간', '100%', 0)]}),
  ]};
  const {root, click} = await openOverlay(USED);
  check('header: which way the numbers read, beside the brand', [text(root.querySelector('.brand')), text(root.querySelector('.hd > .muted'))], ['Leeway 사용', '2분 전 확인']);
  check('28% used is 72 left: green, the bar as long as the 28', [root.querySelector('.big').className, root.querySelector('.bar i').getAttribute('style')], ['big good', 'width:28%']);
  check('100% used (0 left): red', root.querySelector('.sub b')?.outerHTML, '<b class="bad">100%</b>');
  await click();
  const arc = root.querySelectorAll('circle')[1];
  check('collapsed: no tag; the ring as long as the 28, green',
    [root.querySelector('.plan'), arc?.getAttribute('stroke-dasharray').split(' ')[0], arc?.getAttribute('stroke')],
    [null, (2 * Math.PI * 10 * 0.28).toFixed(1), '#3fca82']);
}
{
  const {root} = await openOverlay({...DATA, mode: 'remaining'});
  check('left: tagged as left', text(root.querySelector('.brand')), `Leeway ${KO.mode_left}`);
}

console.log('\ncollapsed — a service with nothing read yet keeps its place');
{
  const {root, click} = await openOverlay({checked: '', providers: [provider('claude', {state: 'waiting', status: '대기 중'}), provider('chatgpt', {rows: [row('5시간', '61%', '', true)]})], peers: []});
  await click();
  check('"?" for it, and no full blocks in the strip (the old fallback)', [[...root.querySelectorAll('.ci b')].map(text), root.querySelectorAll('.prov').length], [['?', '61%'], 0]);
}

console.log('\nopening height — measured in the opener first: requestWindow spends the click, and resizeTo after it does nothing');
{
  // jsdom has no layout: here a measured #ov is 30 + 60 per service block.
  const measure = new JSDOM('<!doctype html><html><head></head><body><div id="ov"></div></body></html>');
  const widths = [];
  Object.defineProperty(measure.window.HTMLElement.prototype, 'scrollHeight', {configurable: true, get() {
    if (this.id !== 'ov') return 0;
    widths.push(this.style.width);
    return 30 + 60 * this.querySelectorAll('.prov').length;
  }});
  const openWith = async data => {
    const pip = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    Object.assign(pip.window, {outerHeight: 270, innerHeight: 240, resizeTo() {}});
    const requests = [];
    await openPip({window: null, requestWindow: async options => { requests.push(options); return pip.window; }}, structuredClone(data), measure.window.document);
    return requests[0];
  };
  const MANY = {checked: '', providers: [provider('claude', {accounts: Array.from({length: 9}, (_, i) => ({label: `Org ${i}`, state: 'ok', status: '정상', rows: [row('5시간', '50%', '', true)]}))})], peers: []};
  check('three services: opens as tall as they are', await openWith(DATA), {width: 280, height: 210, preferInitialWindowPlacement: true});
  check('measured at the width it opens with', widths.at(-1), '280px');
  check('nothing on: not lower than 140', (await openWith(NOTHING)).height, 140);
  check('nine blocks: as tall as they are — no 520 limit, nothing scrolls any more', (await openWith(MANY)).height, 570);
  check("the hidden copy is gone again; the opener's own #ov untouched", [measure.window.document.querySelectorAll('#ov').length, measure.window.document.getElementById('ov').innerHTML], [1, '']);
}

// What the overlay draws, character for character, pinned before it moved from
// overlay_inject.js (injected into a web page) to the Leeway window
// (2026-10-28, feat/overlay-window): the move changes where it runs, not what
// it shows. tests/fixtures/overlay_markup.json was written from
// overlay_inject.js at main 85867e0; regenerate it only for an intended change.
const MARKUP = JSON.parse(readFileSync(new URL('./fixtures/overlay_markup.json', import.meta.url), 'utf8'));
function same(label, got, expected) {
  const ok = got === expected;
  let at = 0;
  while (!ok && at < Math.min(String(got).length, String(expected).length) && got[at] === expected[at]) at += 1;
  console.log(`  [${ok ? PASS : FAIL}] ${label}${ok ? '' : `: differs at ${at}: got ${JSON.stringify(String(got).slice(at, at + 80))} expected ${JSON.stringify(String(expected).slice(at, at + 80))}`}`);
  ok ? passed++ : failed++;
}

console.log('\npinned markup — the same HTML and style as before the move');
{
  const {pip, root, click} = await openOverlay(DATA);
  same('style', pip.window.document.head.querySelector('style')?.textContent, MARKUP.css);
  same('expanded: 72%, 0%, "?" and a stale service', root.innerHTML, MARKUP.expanded);
  await click();
  same('collapsed: rings, 0% and "?"', root.innerHTML, MARKUP.collapsed);
}
{
  const {root} = await openOverlay(ORGS);
  same('expanded: Claude organizations, an off and a waiting service', root.innerHTML, MARKUP.organizations);
}
{
  const {root} = await openOverlay(PEERS);
  same('expanded: another profile, markup from storage escaped', root.innerHTML, MARKUP.peers);
}
{
  const {root, click} = await openOverlay(NOTHING);
  same('expanded: nothing on', root.innerHTML, MARKUP.nothing);
  await click();
  same('collapsed: nothing on', root.innerHTML, MARKUP.nothingCollapsed);
}
check('the pins hold 0%, "?", a stale service and the strip',
  [MARKUP.expanded.includes('>0%<'), MARKUP.expanded.includes('>?<'), MARKUP.expanded.includes('class="prov dim"'), MARKUP.collapsed.includes('class="ci dim"')], [true, true, true, true]);

// The window's size and the drawing in it (overlay_fit.js, CLAUDE.md §4).
// A measured #ov here: expanded 280 wide, 30 + 60 per block; the strip 58
// high and as wide as the services in it — 30 + 110 each with names (three
// make 360), 20 + 70 each without (three make 230).
const measured = (el) => {
  if (!el.classList.contains('compact')) return [280, 30 + 60 * el.querySelectorAll('.prov').length];
  const services = el.querySelectorAll('.ci').length;
  return [el.classList.contains('bare') ? 20 + 70 * services : 30 + 110 * services, 58];
};
// Chrome's frame as measured on Windows at 100%: 16 wide (an invisible border
// left and right), 42 high (title bar and the bottom border).
const sized = (width, height) => ({innerWidth: width, innerHeight: height, outerWidth: width + 16, outerHeight: height + 42});

console.log('\nthe window — sized on open and by a click only, with both sides of the frame');
{
  const {resizes, requests, click, show} = await openOverlay(DATA, sized(280, 210), measured);
  check('opened at the size asked for, with the option; no resizeTo after it', [requests, resizes], [[{width: 280, height: 270, preferInitialWindowPlacement: true}], []]);
  await click();
  check('collapse: the strip for three services (360×58) plus the frame measured on both sides → 376×100', resizes.at(-1), [376, 100]);
  await click();
  check('expand: 280 + 16 wide, the content measured in the PiP (210) + 42 high', resizes.at(-1), [296, 252]);
  const count = resizes.length;
  await show({...DATA, providers: [...DATA.providers, provider('claude', {rows: [row('5시간', '10%', '', true)]})]});
  check('new values make it taller: the window is left as it is', resizes.length, count);
  await click();
  await click();
  check('until the next clicks: then it is fitted to the new height (270 + 42)', resizes.at(-1), [296, 312]);
}

console.log('\nthe drawing — its own size whatever the window: shrunk, never enlarged, never scrolled');
{
  const o = await openOverlay(DATA, sized(280, 210), measured);
  const doc = o.pip.window.document;
  const state = () => [o.root.className, o.root.style.transform, doc.body.className];
  check('the window at its size: expanded as it is', state(), ['', '', '']);
  await o.resize(600, 500);
  check('dragged bigger: not enlarged (top left, the rest the background)', state(), ['', '', '']);
  await o.resize(275, 205);
  check('dragged smaller: shrunk by the smaller of the two ratios', state(), ['', `scale(${Math.min(275 / 280, 205 / 210)})`, '']);
  await o.resize(400, 120);
  check('too low for 10px text: drawn as the strip, vertically centred', state(), ['compact', '', 'strip']);
  await o.resize(280, 210);
  check('dragged back to its size: expanded again (the pick never changed)', state(), ['', '', '']);
  await o.resize(240, 52);
  check("Chrome's smallest, 240×52: the strip without names, shrunk to the 52", state(), ['compact bare', `scale(${52 / 58})`, 'strip']);
  same('only the class and the scale change, not what is drawn', o.root.innerHTML, MARKUP.collapsed);
  check('the strip keeps its rings and values', [o.root.querySelectorAll('.ci svg').length, [...o.root.querySelectorAll('.ci b')].map(text)], [3, ['72%', '0%', '?']]);
  check('none of that resized the window', o.resizes, []);
  const fit = doc.head.querySelectorAll('style')[1]?.textContent || '';
  check('the PiP style: no scrolling, the strip as wide as its services and centred both ways, names hidden only without room',
    ['html,body{height:100%;overflow:hidden}', 'body.strip{justify-content:center;align-items:center}', '#ov.compact{width:max-content;', 'transform-origin:50% 50%', '#ov.bare .ci > span{display:none}'].map(s => fit.includes(s)), [true, true, true, true, true]);
  check('the strip has no minimum width of its own: the window is sized to it instead', fit.includes('min-width'), false);

  await o.resize(1536, 830);
  await o.click();
  check('picked collapsed in a big window (0.8 of the screen): the strip as it is, centred', state(), ['compact', '', 'strip']);
  await o.resize(330, 100);
  check('narrower: the strip shrunk', state(), ['compact', `scale(${330 / 360})`, 'strip']);
}

console.log('\nthe strip is as wide as the services that are on (CLAUDE.md §4)');
{
  const o = await openOverlay({...DATA, providers: [DATA.providers[0]]}, sized(280, 210), measured);
  await o.click();
  check('one service: its 140 of strip is under the smallest PiP Chrome gives, so the window is that 240, not the 360 three take (+16 of frame; 58 + 42 high)',
    o.resizes.at(-1), [256, 100]);
  check('drawn at its own size, centred in the window', [o.root.className, o.root.style.transform], ['compact', '']);
  const before = o.resizes.length;
  await o.show({...DATA, providers: DATA.providers.slice(0, 2)});
  check('a second service turned on: the window is left as it is until the next click', o.resizes.length, before);
  await o.click();
  await o.click();
  check('clicked back to the strip: the 250 the two take (+16)', o.resizes.at(-1), [266, 100]);
  await o.show(DATA);
  await o.click();
  await o.click();
  check('all three on: 360 (+16), as before', o.resizes.at(-1), [376, 100]);
}

console.log('\nthe drawing — new values in a window left as it was');
{
  const o = await openOverlay(DATA, sized(400, 210), measured);
  check('three services in 400×210: expanded as it is', o.root.className, '');
  const orgs = provider('claude', {rows: [row('5시간', '60%', '', true)], accounts: [1, 2, 3].map(i => ({label: `Org ${i}`, state: 'ok', status: '정상', rows: [row('5시간', '60%', '', true)]}))});
  await o.show({...DATA, providers: [orgs, ...DATA.providers.slice(1)]});
  check('five blocks no longer fit 210: the strip, and the window untouched', [o.root.className, o.resizes], ['compact', []]);
  await o.show(DATA);
  check('back to three: expanded again', o.root.className, '');
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
