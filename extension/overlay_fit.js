// Pure functions — no chrome.*, no fetch, no document.
// How big the always-on-top overlay is meant to be, and how it is drawn in
// whatever size its window really has (CLAUDE.md §4). Chrome lets the user
// drag a Document PiP window to any size, and a border drag gives the page no
// user activation, so resizeTo() can't set it back (NotAllowedError,
// measured 2026-10-30). The window is sized only on open and on the click
// that expands or collapses it; in between, the overlay keeps its own size
// and is shrunk to fit a smaller window, never enlarged.
// Both sizes follow the content, so one service turned on gives a window as
// small as that one service: the expanded overlay's height and the strip's
// width are measured (overlay_view.js) and passed in here.
// Imported by overlay_view.js and tests/test_overlay_fit.mjs.

// The overlay's own size, without Chrome's title bar.
export const EXPANDED_W = 280;
export const EXPANDED_MIN_H = 140; // expanded is as tall as its content, at least this
// The strip is as wide as the services that are on, between these two:
// Chrome opens no PiP narrower than 240 of content (measured, Chrome 156), and
// COMPACT_W stands in when the strip could not be measured (three services).
export const COMPACT_MIN_W = 240;
export const COMPACT_W = 360;
// resizeTo() does not make a PiP lower than 58 of content (measured, Chrome
// 156 at 100%; a border drag goes down to 52), so the strip is 58.
export const COMPACT_H = 58;
export const OPEN_H = 270; // when the content could not be measured: three services fit

// Shrinking stops where the smallest text would go under 10px
// (tests/test_overlay_fit.mjs checks these against overlay_view.js CSS).
// Expanded: the small lines (.muted, .plan, .sub) are 10.5px; the status chip
// is 9.5px, under 10 even at full size, so it is left out. Collapsed: 12px.
export const MIN_TEXT_PX = 10;
export const EXPANDED_TEXT_PX = 10.5;
export const COMPACT_TEXT_PX = 12;
export const EXPANDED_MIN_SCALE = MIN_TEXT_PX / EXPANDED_TEXT_PX;
export const COMPACT_MIN_SCALE = MIN_TEXT_PX / COMPACT_TEXT_PX;
// A layout that gave way comes back only with this much room to spare, or at
// its full size, so a border held at the edge does not flicker between two.
export const FIT_MARGIN = 8;

const size = n => (Number.isFinite(n) && n > 0 ? n : 0);

// The inner size the window is given on open and on a click. `content` is the
// overlay's own size in the layout asked for, as measured: expanded, the
// height it has drawn EXPANDED_W wide; collapsed, the width of the strip for
// the services that are on. Expanded has no upper limit (Chrome keeps the
// window on screen and the drawing fits what it allows); the strip is never
// asked for less than Chrome's smallest PiP, which it would not get anyway.
export function pipSize(mode, content) {
  const own = size(content);
  if (mode === 'compact') return {width: own ? Math.max(COMPACT_MIN_W, Math.ceil(own)) : COMPACT_W, height: COMPACT_H};
  return {width: EXPANDED_W, height: own ? Math.max(EXPANDED_MIN_H, Math.ceil(own)) : OPEN_H};
}

// resizeTo() takes the outer size: the inner one plus what Chrome puts around
// it, measured as outer − inner. On Windows that is the title bar and an
// invisible border left and right (measured: 16×42 at 100%; at 150% 15×41,
// or 14×42 emulated — it rounds, so it is measured each time, not assumed).
export function pipOuterSize(mode, content, frame = {}) {
  const inner = pipSize(mode, content);
  return {width: inner.width + size(frame?.width), height: inner.height + size(frame?.height)};
}

// How to draw in a window whose inner size is `win` ({width, height}) when
// the user's click left it at `mode` ('expanded' | 'compact'). `content` is
// the overlay's own size in each layout: {expanded, compact, bare}, each
// {width, height} (bare: the strip without service names; 0 = not measured).
// `previous` is what this returned last while the user resizes the window
// (null after a click, so the fixed-size window is never held back).
// Returns {mode, scale, names}: the layout drawn, the factor it is shrunk by
// (at most 1), and whether the strip shows the service names. The mode the
// user picked is not changed, only how it is drawn:
//   expanded, unless it would be smaller than EXPANDED_MIN_SCALE — then the strip;
//   the strip with names, unless smaller than COMPACT_MIN_SCALE — then without
//   them, shrunk as far as the window needs (nothing is cut off).
export function fitOverlay(win, mode, content, previous = null) {
  const width = size(win?.width);
  const height = size(win?.height);
  const ratio = (room, need) => (need ? room / need : Infinity);
  const scaleOf = (box, spare = 0) => Math.min(1, ratio(width - spare, size(box?.width)), ratio(height - spare, size(box?.height)));
  if (!width || !height) return {mode: mode === 'compact' ? 'compact' : 'expanded', scale: 1, names: true};
  const fits = (box, least, showing) => scaleOf(box) >= 1 || scaleOf(box, showing ? 0 : FIT_MARGIN) >= least;
  if (mode !== 'compact') {
    const showing = !previous || previous.mode === 'expanded';
    if (fits(content?.expanded, EXPANDED_MIN_SCALE, showing)) return {mode: 'expanded', scale: scaleOf(content?.expanded), names: true};
  }
  const named = !previous || previous.mode !== 'compact' || previous.names;
  if (fits(content?.compact, COMPACT_MIN_SCALE, named)) return {mode: 'compact', scale: scaleOf(content?.compact), names: true};
  return {mode: 'compact', scale: scaleOf(content?.bare), names: false};
}
