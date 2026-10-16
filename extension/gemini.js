// Pure functions — no chrome.*, no fetch, no document.
// Gemini app usage (https://gemini.google.com/usage, CLAUDE.md §2 Gemini).
// Input is the text pulled from the two usage cards by the content script
// gemini_scan.js (which reads the live DOM — the page's class names are hashed
// and change, so the cards are found by their label text, not by class). This
// module turns that text into a collector result: it never touches the DOM, so
// it runs in the service worker and is unit-tested without jsdom.
//
// The page shows USED percentages ("0% 사용됨"): remaining = 100 - used.
// Imported by tests/test_gemini.mjs and (once Gemini is wired) background.js.
import { primaryLimitId } from './snapshot.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// "37% 사용됨" → 37. Never coerced from anything else (CLAUDE.md §1).
export function usedPercent(text) {
  const match = typeof text === 'string' ? text.match(/(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:사용됨|used)/i) : null;
  if (!match) return null;
  const used = Number(match[1].replace(',', '.'));
  return Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null;
}

// The wall clock of timeZone (the browser's when undefined) at an instant.
function wallClock(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(ms).map(part => [part.type, Number(part.value)]));
  return {year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute};
}

// The instant when timeZone's wall clock shows that date and time. The offset
// is taken twice so a daylight-saving change in between is followed.
function zonedInstant(year, month, day, hour, minute, timeZone) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = ms => {
    const w = wallClock(ms, timeZone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - ms;
  };
  const first = wanted - offsetAt(wanted);
  return wanted - offsetAt(first);
}

// "오후 9:19에 초기화" — the next 21:19 — or "9월 11일 오후 4:19에 초기화", read
// against when the page was read (nowMs). {iso, text}, or null when the text
// has no such wording (an English page: not seen yet, its text is kept as is).
const KO_RESET = /((?:(\d{1,2})월\s*(\d{1,2})일\s*)?(오전|오후)\s*(\d{1,2}):(\d{2})\s*에\s*초기화)/;
export function resetOf(text, nowMs, timeZone) {
  const match = typeof text === 'string' ? text.match(KO_RESET) : null;
  if (!match) return null;
  const [, wording, month, day, half, hourText, minuteText] = match;
  const minute = Number(minuteText);
  // A 12-hour clock: 오전 12:05 is 00:05, 오후 12:30 is 12:30.
  if (Number(hourText) > 12 || minute > 59) return null;
  const hour = (Number(hourText) % 12) + (half === '오후' ? 12 : 0);
  const now = wallClock(nowMs, timeZone);
  let at;
  if (month) {
    at = zonedInstant(now.year, Number(month), Number(day), hour, minute, timeZone);
    // No year on the page: a date well in the past is next year's.
    if (at < nowMs - DAY_MS) at = zonedInstant(now.year + 1, Number(month), Number(day), hour, minute, timeZone);
  } else {
    at = zonedInstant(now.year, now.month, now.day, hour, minute, timeZone);
    if (at < nowMs - MINUTE_MS) at = zonedInstant(now.year, now.month, now.day + 1, hour, minute, timeZone);
  }
  return Number.isFinite(at) ? {iso: new Date(at).toISOString(), text: wording} : null;
}

// One card's text → a Limit. `card` is {used, reset}: the raw strings the
// content script pulled from that card, each null when it wasn't there.
function limitOf(id, label, card, nowMs, timeZone) {
  const used = usedPercent(card.used);
  const reset = resetOf(card.reset, nowMs, timeZone);
  return {id, label, remaining_percent: used === null ? null : 100 - used, resets_at: reset?.iso ?? null, reset_text: reset?.text ?? null};
}

// The collector payload (CLAUDE.md §2) from the scanned cards. `cards` is
// {current, weekly}, each either null (the card wasn't on the page) or
// {used, reset} (found — `used` is null when the "% 사용됨" couldn't be read).
// "현재 사용량" is gemini_5h (renews every 5 hours, the primary value);
// "주간 한도" is gemini_weekly. A card that is there but unreadable stays
// listed with null (수집기 계약).
export function geminiPayload(cards, nowMs, timeZone) {
  const c = cards && typeof cards === 'object' ? cards : {};
  const limits = [];
  if (c.current) limits.push(limitOf('gemini_5h', 'Current usage', c.current, nowMs, timeZone));
  if (c.weekly) limits.push(limitOf('gemini_weekly', 'Weekly limit', c.weekly, nowMs, timeZone));
  const failed = detail => ({provider: 'gemini', value: '?', detail, status: 'parse_failed', limits});
  // Without the current-usage card there is no telling whether the account
  // has that limit: no primary then (not even the weekly one).
  if (!c.current) return failed(c.weekly ? 'Gemini current-usage card not found' : 'Gemini usage cards not found');
  const primary = limits.find(limit => limit.id === primaryLimitId('gemini', limits));
  if (primary?.remaining_percent === null) return failed('Gemini current usage has no "% 사용됨"');
  const detail = limits.map(limit => {
    const remaining = limit.remaining_percent === null ? 'unknown' : `${Math.round(limit.remaining_percent)}% remaining`;
    return `${limit.label}: ${remaining}${limit.reset_text ? `, ${limit.reset_text}` : ''}`;
  }).join(' · ');
  return {provider: 'gemini', value: `${Math.round(primary.remaining_percent)}%`, detail, status: 'ok', limits};
}
