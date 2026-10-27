// Pure functions — no chrome.*, no fetch, no document.
// Turns a collector payload into the UsageSnapshot kept in chrome.storage.local
// (CLAUDE.md §2). Imported by background.js and tests/test_snapshot.mjs.

export const PROVIDERS = ['claude', 'chatgpt', 'gemini'];
const STATUSES = new Set(['ok', 'logged_out', 'parse_failed', 'needs_permission', 'disabled']);
const MAX_LIMITS = 8;
// Claude organizations kept per snapshot (one claude.ai sign-in can belong to
// several: a personal plan and a Team workspace, say).
const MAX_ACCOUNTS = 4;
const ACCOUNT_STATUSES = new Set(['ok', 'logged_out', 'parse_failed']);
// A plan is a short product name from parsers.js ("Max 5x", "Plus"), never
// free text from a page.
const PLAN = /^[A-Za-z0-9][A-Za-z0-9 ]{0,15}$/;
// ISO 8601 with an explicit zone. Zone-less strings are rejected: Date.parse
// would read them as local time, which is a guess.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

function planOrNull(value) {
  return typeof value === 'string' && PLAN.test(value) ? value : null;
}

export const usageKey = provider => `usage_${provider}`;
export const lastOkKey = provider => `usage_last_ok_${provider}`;

function shortText(value, max) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

function isoOrNull(value) {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// Failure details can carry a tab URL (chatgpt.com/c/<conversation id>).
// Keep only the origin.
function withoutUrlPaths(text) {
  return text && text.replace(/(https?:\/\/[^\s/?#]+)[/?#][^\s:]*/g, '$1');
}

// remaining_percent must already be a number or null. Anything else becomes
// null — never coerced (Number('') === 0 would turn "no value" into 0%,
// CLAUDE.md §1) and never dropped (a dropped 5-hour entry would read as "this
// account has no 5-hour limit").
function toLimit(raw, provider) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.startsWith(`${provider}_`)) return null;
  const pct = raw.remaining_percent;
  const remaining = typeof pct === 'number' && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  const id = raw.id.slice(0, 40);
  return {
    id,
    label: shortText(raw.label, 40) ?? id,
    remaining_percent: remaining,
    resets_at: isoOrNull(raw.resets_at),
    reset_text: shortText(raw.reset_text, 80),
  };
}

// CLAUDE.md §1: the 5-hour limit; weekly only when there is no 5-hour limit at
// all (e.g. ChatGPT Pro). Collector contract (CLAUDE.md §2): a 5-hour limit the
// account has but that couldn't be read is still listed, with a null value, so
// it keeps winning here and the weekly value is never promoted in its place.
// Only meaningful for an "ok" result — after a failed read a missing entry
// proves nothing, so toSnapshot() sets no primary then.
export function primaryLimitId(provider, limits) {
  for (const suffix of ['5h', 'weekly']) {
    const id = `${provider}_${suffix}`;
    if (limits.some(limit => limit.id === id)) return id;
  }
  return limits[0]?.id ?? null;
}

function toLimits(rawLimits, provider) {
  const limits = [];
  for (const raw of Array.isArray(rawLimits) ? rawLimits : []) {
    const limit = toLimit(raw, provider);
    if (limit && !limits.some(existing => existing.id === limit.id)) limits.push(limit);
    if (limits.length === MAX_LIMITS) break;
  }
  return limits;
}

// One organization's own read. Same rule as the snapshot: ok only when its
// primary value was read.
function toAccount(raw, provider) {
  if (!raw || typeof raw !== 'object') return null;
  const limits = toLimits(raw.limits, provider);
  let status = ACCOUNT_STATUSES.has(raw.status) ? raw.status : 'parse_failed';
  let primary = null;
  if (status === 'ok') {
    primary = primaryLimitId(provider, limits);
    if ((limits.find(limit => limit.id === primary)?.remaining_percent ?? null) === null) {
      status = 'parse_failed';
      primary = null;
    }
  }
  return {plan: planOrNull(raw.plan), status, primary_limit_id: primary, limits};
}

export function toSnapshot(payload, nowMs) {
  const provider = typeof payload?.provider === 'string' ? payload.provider.toLowerCase() : '';
  if (!PROVIDERS.includes(provider)) return null;
  const limits = toLimits(payload.limits, provider);
  const accounts = (Array.isArray(payload.accounts) ? payload.accounts : [])
    .map(raw => toAccount(raw, provider)).filter(Boolean).slice(0, MAX_ACCOUNTS);
  let status = STATUSES.has(payload.status) ? payload.status : 'parse_failed';
  let detail = withoutUrlPaths(shortText(payload.detail, 200));
  let primary = null;
  // "ok" means the primary value was read. Otherwise it is not ok, and must not
  // replace the last good snapshot.
  if (status === 'ok') {
    primary = primaryLimitId(provider, limits);
    const value = limits.find(limit => limit.id === primary)?.remaining_percent ?? null;
    if (value === null) {
      detail = primary ? `ok payload, but ${primary} has no value` : 'ok payload without a readable limit';
      status = 'parse_failed';
      primary = null;
    }
  }
  const snapshot = {
    provider,
    status,
    collected_at: new Date(nowMs).toISOString(),
    primary_limit_id: primary,
    limits,
    detail,
  };
  // Optional keys, added only when there is something to show.
  const plan = planOrNull(payload.plan);
  if (plan) snapshot.plan = plan;
  // Only when there is more than the one account the top level already shows.
  if (accounts.length > 1) snapshot.accounts = accounts;
  return snapshot;
}

// A snapshot another Chrome profile shared through the Leeway helper. It was
// sanitized there, but it crossed a process and a file, so every value is
// checked again here, and only an ok snapshot with a readable time is kept.
// Its own collected_at is kept, so its age shows as it is.
export function fromShared(raw) {
  if (!raw || typeof raw !== 'object' || raw.status !== 'ok') return null;
  const collectedAt = isoOrNull(raw.collected_at);
  if (!collectedAt) return null;
  const snapshot = toSnapshot({provider: raw.provider, status: 'ok', limits: raw.limits, plan: raw.plan, accounts: raw.accounts}, Date.parse(collectedAt));
  return snapshot && snapshot.status === 'ok' ? snapshot : null;
}

// Everything one payload writes, as a single chrome.storage.local.set() object.
// usage_<provider> always holds the latest attempt. usage_last_ok_<provider>
// holds the latest "ok" one. It survives failed reads and logged_out (a 403
// can be transient; the display decides what to show), and is cleared to null
// only when the user turns the provider off or its permission is gone.
export function snapshotWrites(payload, nowMs) {
  const snapshot = toSnapshot(payload, nowMs);
  if (!snapshot) return null;
  const writes = {[usageKey(snapshot.provider)]: snapshot};
  if (snapshot.status === 'ok') writes[lastOkKey(snapshot.provider)] = snapshot;
  else if (snapshot.status === 'disabled' || snapshot.status === 'needs_permission') writes[lastOkKey(snapshot.provider)] = null;
  return writes;
}
