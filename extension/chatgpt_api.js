// Pure functions — no chrome.*, no fetch, no document.
// ChatGPT's own Settings > Usage page reads GET /backend-api/wham/usage
// (unofficial; CLAUDE.md §2). This turns that JSON into the collector payload.
// Only rate_limit's windows are read: the response also carries the email and
// user/account ids, which go nowhere. Imported by background.js and
// tests/test_chatgpt_api.mjs.
import { chatgptPlanLabel, fmtReset } from './parsers.js';
import { primaryLimitId } from './snapshot.js';

const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;
const KNOWN_WINDOWS = {[5 * HOUR_S]: ['5h', '5-hour limit'], [7 * DAY_S]: ['weekly', 'Weekly limit']};

const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// The window's length says what it is, not its name: primary_window was the
// weekly one on ChatGPT Pro, and a single 30-day window on an account checked
// 2026-10-15 (CLAUDE.md §2).
export function windowKind(seconds) {
  if (KNOWN_WINDOWS[seconds]) {
    const [suffix, label] = KNOWN_WINDOWS[seconds];
    return {suffix, label};
  }
  if (seconds >= 28 * DAY_S) return {suffix: 'monthly', label: 'Monthly limit'};
  const span = seconds % DAY_S === 0 ? `${seconds / DAY_S}-day`
    : seconds % HOUR_S === 0 ? `${seconds / HOUR_S}-hour` : `${Math.round(seconds / 60)}-minute`;
  return {suffix: `${seconds}s`, label: `${span} limit`};
}

function windowsOf(body) {
  const rateLimit = body?.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object') return [];
  return [rateLimit.primary_window, rateLimit.secondary_window].filter(w => w && typeof w === 'object');
}

// Windows that are there but can't be placed: not an object, or no usable
// length. One of them might be the 5-hour window.
function unplacedWindows(body) {
  const rateLimit = body?.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object') return 0;
  return [rateLimit.primary_window, rateLimit.secondary_window]
    .filter(w => w != null && !(typeof w === 'object' && isNumber(w.limit_window_seconds) && w.limit_window_seconds > 0))
    .length;
}

// For diagnostics: lengths and used percentages only.
export function whamWindows(body) {
  return windowsOf(body).map(w => ({
    seconds: isNumber(w.limit_window_seconds) ? w.limit_window_seconds : null,
    used: isNumber(w.used_percent) ? w.used_percent : null,
  }));
}

// For diagnostics: the plan name ("free", "plus", ...) when it looks like one.
export function whamPlan(body) {
  const plan = body?.plan_type;
  return typeof plan === 'string' && /^[a-z][a-z0-9_-]{0,23}$/i.test(plan) ? plan : null;
}

// reset_at is Unix seconds. A time that can't be right (another unit, a bad
// value) becomes null rather than a date years away — or a thrown RangeError
// that would lose the whole read.
function resetsAt(window, nowMs) {
  const ms = isNumber(window.reset_at) ? window.reset_at * 1000
    : isNumber(window.reset_after_seconds) ? nowMs + window.reset_after_seconds * 1000 : NaN;
  const plausible = ms >= nowMs - DAY_S * 1000 && ms <= nowMs + 400 * DAY_S * 1000;
  return plausible ? new Date(ms).toISOString() : null;
}

// used_percent → remaining (CLAUDE.md §1). A window without a usable
// used_percent stays listed with null — leaving it out could make another
// window the primary one (CLAUDE.md §2 수집기 계약). A 5-hour entry is left
// out only when no window is 5 hours long: that is the evidence the account
// has no 5-hour limit.
export function whamLimits(body, nowMs) {
  const limits = [];
  for (const window of windowsOf(body)) {
    const seconds = window.limit_window_seconds;
    if (!isNumber(seconds) || seconds <= 0) continue;
    const {suffix, label} = windowKind(seconds);
    const id = `chatgpt_${suffix}`;
    if (limits.some(limit => limit.id === id)) continue;
    const used = isNumber(window.used_percent) ? Math.max(0, Math.min(100, window.used_percent)) : null;
    limits.push({
      id, label, seconds,
      remaining_percent: used === null ? null : 100 - used,
      resets_at: resetsAt(window, nowMs),
      reset_text: null,
    });
  }
  return limits.sort((a, b) => a.seconds - b.seconds).map(({seconds, ...limit}) => limit);
}

// The collector payload (CLAUDE.md §2). value/detail are the legacy strings
// the Python overlay shows. ok only when the primary value was read; the
// readable limits stay in a failed payload for display.
export function whamPayload(body, nowMs) {
  const limits = whamLimits(body, nowMs);
  // The plan, as a fixed label ("Plus"), or null. Shown next to the name.
  const plan = chatgptPlanLabel(whamPlan(body));
  const failed = detail => ({provider: 'chatgpt', value: '?', detail, status: 'parse_failed', limits, plan});
  // A window that can't be placed might be the 5-hour one: then no other
  // window may become the primary (CLAUDE.md §2 수집기 계약).
  if (unplacedWindows(body)) return failed('wham/usage: a window has no usable limit_window_seconds');
  if (!limits.length) return failed('wham/usage: no rate_limit window');
  const primary = limits.find(limit => limit.id === primaryLimitId('chatgpt', limits));
  if (!isNumber(primary?.remaining_percent)) return failed(`wham/usage: ${primary.label} has no usable used_percent`);
  const value = `${Math.round(primary.remaining_percent)}%`;
  const detail = limits.map(limit => {
    const remaining = isNumber(limit.remaining_percent) ? `${Math.round(limit.remaining_percent)}% remaining` : 'unknown';
    const reset = limit.resets_at ? `, resets ${fmtReset(limit.resets_at)}` : '';
    return `${limit.label}: ${remaining}${reset}`;
  }).join(' · ');
  return {provider: 'chatgpt', value, detail, status: 'ok', limits, plan};
}
