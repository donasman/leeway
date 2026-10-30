// Run with: node tests/test_overlay_fit.mjs
//
// extension/overlay_fit.js — the always-on-top overlay's own size, and how it
// is drawn in whatever size the user dragged its window to (CLAUDE.md §4):
// the window sizes a click or opening asks for (with Chrome's frame), and
// fitOverlay() at its edges — exactly the fixed size, just under and over the
// shrink limits, the margin that keeps a layout from flickering, Chrome's
// smallest PiP (240×52) and its largest (0.8 of a 1920×1080 screen).
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

const fit = await import('../extension/overlay_fit.js');
const { fitOverlay, pipSize, pipOuterSize, EXPANDED_MIN_SCALE, COMPACT_MIN_SCALE, COMPACT_MIN_W, FIT_MARGIN } = fit;

// Three services: expanded 280 wide, 202 tall (as measured in Chrome 156);
// the strip 360×58 with names, 230 wide without.
const CONTENT = { expanded: { width: 280, height: 202 }, compact: { width: 360, height: 58 }, bare: { width: 230, height: 58 } };
const at = (width, height, mode = 'expanded', previous = null, content = CONTENT) => fitOverlay({ width, height }, mode, content, previous);
const expanded = scale => ({ mode: 'expanded', scale, names: true });
const strip = scale => ({ mode: 'compact', scale, names: true });
const bare = scale => ({ mode: 'compact', scale, names: false });

console.log('\nthe sizes a click or opening gives the window');
check('expanded: 280 wide, as tall as its content', pipSize('expanded', 202), { width: 280, height: 202 });
check('expanded: not lower than 140', pipSize('expanded', 90), { width: 280, height: 140 });
check('expanded: no upper limit any more (nothing scrolls)', pipSize('expanded', 900), { width: 280, height: 900 });
check('expanded: a fraction of a pixel is rounded up, not cut', pipSize('expanded', 201.2).height, 202);
check('expanded, content not measured: three services\' worth', pipSize('expanded', 0), { width: 280, height: 270 });
check('collapsed: as wide as the strip it was given, 58 high (resizeTo goes no lower)', pipSize('compact', 360), { width: 360, height: 58 });
check('collapsed, one service (139 of strip): the window follows it down to the smallest PiP Chrome gives', [pipSize('compact', 139), COMPACT_MIN_W], [{ width: 240, height: 58 }, 240]);
check('collapsed, two services: in between, the width of the strip itself', pipSize('compact', 262), { width: 262, height: 58 });
check('collapsed: a fraction of a pixel is rounded up, not cut', pipSize('compact', 261.2).width, 262);
check('collapsed, strip not measured: three services wide', pipSize('compact', 0), { width: 360, height: 58 });
check('resizeTo gets the outer size: 16×42 of frame at 100% (measured)', pipOuterSize('compact', 360, { width: 16, height: 42 }), { width: 376, height: 100 });
check('… 14×42 at 150%', pipOuterSize('expanded', 202, { width: 14, height: 42 }), { width: 294, height: 244 });
check('no frame measured (or a negative one): the inner size', pipOuterSize('expanded', 202, { width: -3, height: NaN }), { width: 280, height: 202 });

console.log('\nthe shrink limits come from the overlay\'s own text sizes');
{
  const { CSS } = await import('../extension/overlay_view.js');
  // font-size per rule of the overlay's CSS, e.g. "#ov .muted" -> 10.5
  const sizes = Object.fromEntries([...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(([, selector, body]) => [selector.trim(), body.match(/font-size:([\d.]+)px/)?.[1]])
    .filter(([, px]) => px).map(([selector, px]) => [selector, Number(px)]));
  const expandedText = Object.entries(sizes).filter(([s]) => !/\.chip|\.ci|\.empty/.test(s)).map(([, px]) => px);
  check('expanded: smallest text 10.5px (the 9.5px chip left out)', [Math.min(...expandedText), fit.EXPANDED_TEXT_PX, sizes['#ov .chip']], [10.5, 10.5, 9.5]);
  check('collapsed: the strip\'s text is 12px', [sizes['#ov .ci'], fit.COMPACT_TEXT_PX], [12, 12]);
  check('limits: 10/10.5 and 10/12', [EXPANDED_MIN_SCALE, COMPACT_MIN_SCALE], [10 / 10.5, 10 / 12]);
}

console.log('\nexpanded — at its size, bigger, smaller');
check('exactly its size: as it is', at(280, 202), expanded(1));
check('bigger (0.8 of 1920×1080: 1536×830 of content): never enlarged', at(1536, 830), expanded(1));
check('only taller: as it is', at(280, 600), expanded(1));
check('narrower: shrunk by the width', at(270, 400), expanded(270 / 280));
check('shrunk by the smaller of the two ratios (height here)', at(275, 196), expanded(196 / 202));
check('shrunk by the smaller of the two ratios (width here)', at(272, 200), expanded(272 / 280));
check('content height not measured: the width decides', at(275, 50, 'expanded', null, { ...CONTENT, expanded: { width: 280, height: 0 } }), expanded(275 / 280));

console.log('\nexpanded — the shrink limit (10px text): 267 wide still fits, 266 is the strip');
{
  const least = Math.ceil(280 * EXPANDED_MIN_SCALE); // 267
  check('267 = the narrowest at or above 10/10.5', [least, least / 280 >= EXPANDED_MIN_SCALE, (least - 1) / 280 < EXPANDED_MIN_SCALE], [267, true, true]);
  check('just above the limit: expanded, shrunk', at(least, 202), expanded(least / 280));
  check('just below: the strip, at 266/360 too small for names → no names', at(least - 1, 202), bare(1));
  const lowest = Math.ceil(202 * EXPANDED_MIN_SCALE); // 193
  check('the same by height: 193 still fits, 192 does not', [at(280, lowest).mode, at(280, lowest - 1).mode], ['expanded', 'compact']);
  check('too low for expanded: the strip with names when it is wide enough', at(400, 120), strip(1));
}

console.log('\nexpanded — the margin: in between, it stays as it was drawn');
{
  // Expanded gave way below 267; it comes back from 267 + 8 = 275.
  let drawn = at(280, 202);
  const path = [270, 268, 272, 267, 270];
  const seen = path.map(w => (drawn = at(w, 202, 'expanded', drawn)).mode);
  check('shown expanded, the border moved back and forth inside the band: stays expanded', seen, ['expanded', 'expanded', 'expanded', 'expanded', 'expanded']);
  drawn = at(260, 202, 'expanded', drawn);
  check('under the limit: the strip', drawn.mode, 'compact');
  const back = [267, 270, 274, 270].map(w => (drawn = at(w, 202, 'expanded', drawn)).mode);
  check('gave way: inside the band it stays the strip', back, ['compact', 'compact', 'compact', 'compact']);
  check(`with ${FIT_MARGIN}px to spare (275): expanded again`, (drawn = at(275, 202, 'expanded', drawn)).mode, 'expanded');
  const strip150 = at(400, 120, 'expanded', null, { ...CONTENT, expanded: { width: 280, height: 150 } });
  check('at its full size it always comes back, even when that is inside the margin (150 high)',
    at(280, 150, 'expanded', strip150, { ...CONTENT, expanded: { width: 280, height: 150 } }), expanded(1));
  check('after a click (no previous): no margin', at(268, 202, 'expanded', null), expanded(268 / 280));
}

console.log('\ncollapsed — the strip, then without names');
check('picked collapsed: the strip at its size', at(360, 58, 'compact'), strip(1));
check('a big window: the strip as it is (never enlarged)', at(1536, 830, 'compact'), strip(1));
check('narrower: shrunk', at(330, 58, 'compact'), strip(330 / 360));
check('just above 10/12 (301 wide): names', at(301, 58, 'compact'), strip(301 / 360));
check('just below (299): no names, as it fits', at(299, 58, 'compact'), bare(1));
check('lower than 58: shrunk by the height', at(360, 52, 'compact'), strip(52 / 58));
{
  let drawn = at(299, 58, 'compact');
  const back = [301, 305, 309].map(w => (drawn = at(w, 58, 'compact', drawn)).names);
  check(`names gone: back only with ${FIT_MARGIN}px to spare (309 − 8 = 301 ≥ 360 × 10/12)`, back, [false, false, true]);
  drawn = at(320, 58, 'compact');
  check('names shown: they stay down to the limit', [301, 304].map(w => (drawn = at(w, 58, 'compact', drawn)).names), [true, true]);
}

console.log('\nChrome\'s smallest PiP (240×52) and odd sizes');
check('240×52, expanded picked: the strip without names, shrunk to the 52', at(240, 52), bare(52 / 58));
check('240×52, collapsed picked: the same', at(240, 52, 'compact'), bare(52 / 58));
check('narrower than even the bare strip: shrunk further, nothing cut off', at(200, 58, 'compact'), bare(200 / 230));
check('window size unknown: drawn as picked, as it is', [at(0, 0), at(NaN, 200, 'compact')], [expanded(1), strip(1)]);
check('content not measured at all: drawn as picked, as it is', fitOverlay({ width: 240, height: 52 }, 'expanded', {}), expanded(1));

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
