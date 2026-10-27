// Pure functions — no chrome.*, no fetch, no document.
// Turns what publish() stored (CLAUDE.md §2 저장 키) into what the popup shows.
// The toolbar badge (CLAUDE.md §4) is to reuse currentValues(), primaryLimit()
// and isStale(). Imported by popup.js and tests/test_view.mjs.
//
// i18n: this stays a pure module, so it can't call chrome.i18n. The caller
// (popup.js / background.js) passes a `labels` map (key -> text, built from
// chrome.i18n); tests pass the map built from _locales/<lang>/messages.json.
// Template values use {token} placeholders that `fill` substitutes.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Older than this is stale: three missed 2-minute polls (CLAUDE.md §4).
export const STALE_MS = 6 * MINUTE_MS;

// The page's own reset wording, as chatgpt.js keeps it: "N일 N시간 N분 후 초기화".
// The regex parses that Korean text (the ChatGPT page's language); each entry
// carries its milliseconds and the label key used to re-emit it in the UI's
// language.
const PAGE_UNITS = [[DAY_MS, 'unit_day'], [HOUR_MS, 'unit_hour'], [MINUTE_MS, 'unit_minute']];
const PAGE_RESET = /^(?:(\d+)\s*일)?\s*(?:(\d+)\s*시간)?\s*(?:(\d+)\s*분)?\s*후\s*초기화$/;

const isPercent = value => typeof value === 'number' && Number.isFinite(value);
const limitsOf = snapshot => (Array.isArray(snapshot?.limits) ? snapshot.limits.filter(l => l && typeof l === 'object') : []);
const ageOf = (snapshot, nowMs) => nowMs - Date.parse(snapshot?.collected_at);
const pad = value => String(value).padStart(2, '0');

// Replace {token} in a label template with vars[token] (missing -> ''). A label
// that is missing from the map is '', never a crash.
const fill = (tpl, vars = {}) => String(tpl ?? '').replace(/\{(\w+)\}/g, (_, key) => (key in vars ? String(vars[key]) : ''));
// parts: [[count, unitKey], ...] -> "2시간 48분" / "2h 48m" from the label words.
// durNumSep sits between the count and its unit, durPartSep between the parts,
// both set per UI locale by i18n.js (es: "2 h 48 min", ja/zh: "2時間48分").
const composeDur = (parts, labels) => {
  const numSep = labels.durNumSep ?? '';
  const partSep = labels.durPartSep ?? ' ';
  return parts.map(([count, unitKey]) => `${count}${numSep}${labels[unitKey] ?? ''}`).join(partSep);
};

// null (cleared) or a stored value without a status reads as nothing stored
// (CLAUDE.md §2).
export function asSnapshot(value) {
  return value && typeof value === 'object' && typeof value.status === 'string' ? value : null;
}

// Stale: older than STALE_MS, no readable collected_at, or stamped more than a
// minute ahead (the clock was set back since).
export function isStale(snapshot, nowMs) {
  const age = ageOf(snapshot, nowMs);
  return !(age <= STALE_MS && age >= -MINUTE_MS);
}

// Which stored values to show: the latest attempt when it is ok. After a
// failed read (parse_failed, logged_out) the last ok one, marked fromLastOk.
// Nothing after disabled / needs_permission — those cleared the last ok one.
export function currentValues(latest, lastOk) {
  latest = asSnapshot(latest);
  lastOk = asSnapshot(lastOk);
  if (latest?.status === 'ok') return {snapshot: latest, fromLastOk: false};
  if (lastOk?.status !== 'ok') return null;
  if (!latest) return {snapshot: lastOk, fromLastOk: false};
  if (latest.status === 'parse_failed' || latest.status === 'logged_out') return {snapshot: lastOk, fromLastOk: true};
  return null;
}

// The primary limit of an ok snapshot (CLAUDE.md §1), or null. snapshot.js
// picked it when storing; a snapshot that isn't ok has none.
export function primaryLimit(snapshot) {
  snapshot = asSnapshot(snapshot);
  if (snapshot?.status !== 'ok' || typeof snapshot.primary_limit_id !== 'string') return null;
  const limit = limitsOf(snapshot).find(l => l.id === snapshot.primary_limit_id);
  return limit && isPercent(limit.remaining_percent) ? limit : null;
}

// 0 is a value: "0%". Only a missing value is "?" (CLAUDE.md §1).
export function formatPercent(value) {
  return isPercent(value) ? `${Math.round(value)}%` : '?';
}

export function limitLabel(limit, labels = {}) {
  const id = typeof limit?.id === 'string' ? limit.id : '';
  const kind = id.slice(id.indexOf('_') + 1);
  if (kind === '5h' || kind === 'weekly' || kind === 'monthly') return labels['limit_' + kind] ?? kind;
  return typeof limit?.label === 'string' && limit.label ? limit.label : id;
}

export function formatAge(ageMs, labels = {}) {
  if (!Number.isFinite(ageMs) || ageMs < -MINUTE_MS) return '';
  if (ageMs < MINUTE_MS) return labels.just_now ?? '';
  const numSep = labels.durNumSep ?? ''; // es spaces number and unit ("3 min")
  const amount = (count, unitKey) => fill(labels.ago, {age: `${count}${numSep}${labels[unitKey] ?? ''}`});
  if (ageMs < HOUR_MS) return amount(Math.floor(ageMs / MINUTE_MS), 'unit_minute');
  if (ageMs < DAY_MS) return amount(Math.floor(ageMs / HOUR_MS), 'unit_hour');
  return amount(Math.floor(ageMs / DAY_MS), 'unit_day');
}

// The page's relative wording was true when it was read. Count it again from
// collected_at, in the units the page used, so an older snapshot doesn't show
// a reset hours off. null if the text isn't that wording.
function recountPageReset(text, collectedMs, nowMs, labels) {
  const match = typeof text === 'string' ? text.trim().match(PAGE_RESET) : null;
  const units = PAGE_UNITS.filter((_, i) => match?.[i + 1] !== undefined);
  if (!units.length || !Number.isFinite(collectedMs)) return null;
  const step = units[units.length - 1][0];
  // The page drops what is below its last unit; take the middle of that.
  const at = collectedMs + step / 2 + PAGE_UNITS.reduce((sum, [ms], i) => sum + Number(match[i + 1] ?? 0) * ms, 0);
  // A clock set back since the read must not add time.
  const left = at - Math.max(nowMs, collectedMs);
  if (left <= 0) return labels.reset_passed ?? '';
  let rest = Math.max(step, Math.floor(left / step) * step);
  const parts = units.map(([ms, unitKey]) => {
    const count = Math.floor(rest / ms);
    rest -= count * ms;
    return [count, unitKey];
  });
  while (parts.length > 1 && parts[0][0] === 0) parts.shift();
  return fill(labels.reset_in, {dur: composeDur(parts, labels)});
}

// With resets_at: within a day, how long until the reset; further out, the
// local date and time. Without it, reset_text — the page's relative wording is
// recounted from collectedMs, anything else is shown as stored.
// timeZone is for tests; the popup leaves it to the browser.
export function formatReset(limit, nowMs, timeZone, collectedMs, labels = {}) {
  const at = Date.parse(limit?.resets_at);
  if (Number.isNaN(at)) {
    const text = typeof limit?.reset_text === 'string' ? limit.reset_text : '';
    return recountPageReset(text, collectedMs, nowMs, labels) ?? text;
  }
  const left = at - nowMs;
  if (left <= 0) return labels.reset_passed ?? '';
  if (left < DAY_MS) {
    const minutes = Math.max(1, Math.floor(left / MINUTE_MS));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const parts = [];
    if (hours) parts.push([hours, 'unit_hour']);
    if (rest || !hours) parts.push([rest, 'unit_minute']);
    return fill(labels.reset_in, {dur: composeDur(parts, labels)});
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(at).map(part => [part.type, part.value]));
  const weekday = labels['wd_' + parts.weekday] ?? parts.weekday;
  // The date order and punctuation are per-locale (es is D/M "a las", zh uses
  // 月/日 and full-width brackets); reset_date_fmt carries that as a template.
  const tpl = labels.reset_date_fmt || '{mo}/{day} ({wd}) {hh}:{mi}';
  const date = fill(tpl, {mo: parts.month, day: parts.day, wd: weekday, hh: pad(parts.hour), mi: pad(parts.minute)});
  return fill(labels.reset_at, {date});
}

function rowsOf(snapshot, nowMs, timeZone, labels) {
  const primary = primaryLimit(snapshot);
  const collectedMs = Date.parse(snapshot?.collected_at);
  return limitsOf(snapshot).map(limit => ({
    id: limit.id,
    label: limitLabel(limit, labels),
    percent: formatPercent(limit.remaining_percent),
    reset: formatReset(limit, nowMs, timeZone, collectedMs, labels),
    primary: limit === primary,
  }));
}

function stateOf(snapshot, nowMs) {
  if (snapshot?.status === 'ok') return isStale(snapshot, nowMs) ? 'stale' : 'ok';
  if (snapshot?.status === 'parse_failed' || snapshot?.status === 'logged_out') return snapshot.status;
  // Nothing stored yet, or disabled / needs_permission left from before the
  // provider was (re-)enabled with permission: the next refresh is on its way.
  return 'waiting';
}

// Every Claude organization of the sign-in, when there is more than one: its
// plan as the name ("Max 5x", "Team"), "Account 2" when the plan is unknown,
// and its own rows. Two of the same plan read "Team", "Team 2".
function accountsOf(snapshot, nowMs, timeZone, labels) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts.filter(a => a && typeof a === 'object') : [];
  if (accounts.length < 2) return [];
  const seen = {};
  return accounts.map((account, i) => {
    const base = typeof account.plan === 'string' && account.plan ? account.plan : fill(labels.account_n, {n: i + 1});
    seen[base] = (seen[base] || 0) + 1;
    const state = account.status === 'ok' ? 'ok' : (account.status === 'logged_out' ? 'logged_out' : 'parse_failed');
    const rows = rowsOf({status: account.status, primary_limit_id: account.primary_limit_id, limits: account.limits, collected_at: snapshot.collected_at}, nowMs, timeZone, labels);
    return {
      label: seen[base] > 1 ? `${base} ${seen[base]}` : base,
      state,
      status: labels['status_' + state] ?? '',
      rows: rows.length ? rows : [{id: 'claude_5h', label: labels.limit_5h ?? '5h', percent: '?', reset: '', primary: true}],
    };
  });
}

const checkedAt = (age, labels) => (age ? fill(labels.checked, {age}) : '');
const joinNote = (...parts) => parts.filter(Boolean).join(' · ');

// What the popup shows for one provider. enabled (enabledProviders) and
// permitted (chrome.permissions) are live and win over what the last refresh
// stored, so a provider that is off shows no values (CLAUDE.md §2).
export function providerView({enabled, permitted, latest, lastOk}, nowMs, timeZone, labels = {}) {
  const view = (state, rest = {}) => ({state, status: labels['status_' + state] ?? '', rows: [], dim: false, note: '', detail: '', plan: null, accounts: [], ...rest});
  if (!enabled) return view('off');
  if (!permitted) return view('needs_permission', {note: labels.note_no_permission ?? ''});
  latest = asSnapshot(latest);
  const shown = currentValues(latest, lastOk);
  const state = stateOf(latest ?? shown?.snapshot, nowMs);
  const failed = state === 'parse_failed' || state === 'logged_out';
  const detail = failed && typeof latest?.detail === 'string' ? latest.detail : '';
  if (shown) {
    const age = formatAge(ageOf(shown.snapshot, nowMs), labels);
    const stale = isStale(shown.snapshot, nowMs);
    let note = checkedAt(age, labels);
    if (shown.fromLastOk) note = joinNote(labels.note_last_ok, age);
    else if (stale) note = joinNote(labels.note_stale, checkedAt(age, labels));
    return view(state, {
      rows: rowsOf(shown.snapshot, nowMs, timeZone, labels), dim: shown.fromLastOk || stale, note, detail,
      plan: typeof shown.snapshot.plan === 'string' ? shown.snapshot.plan : null,
      accounts: accountsOf(shown.snapshot, nowMs, timeZone, labels),
    });
  }
  if (!failed) return view(state);
  const checked = checkedAt(formatAge(ageOf(latest, nowMs), labels), labels);
  // A failed read with no earlier ok one may still carry what it could read,
  // e.g. the weekly value. Its 5-hour value stays "?" — listed or not, weekly
  // never takes its place (CLAUDE.md §1).
  const rows = rowsOf(latest, nowMs, timeZone, labels);
  if (rows.length) {
    const fiveHour = `${latest.provider}_5h`;
    if (!rows.some(row => row.id === fiveHour)) rows.unshift({id: fiveHour, label: labels.limit_5h ?? '5h', percent: '?', reset: '', primary: false});
    return view(state, {rows, dim: isStale(latest, nowMs), note: joinNote(labels.note_partial, checked), detail});
  }
  return view(state, {note: joinNote(checked, state === 'logged_out' ? labels.note_login : labels.note_unread), detail});
}

// ---- toolbar badge (CLAUDE.md §4) --------------------------------------------

export const BADGE_COLOR = {green: '#1e8e3e', orange: '#e37400', red: '#d93025', grey: '#80868b'};

// The lowest primary value among the enabled providers, digits only; grey once
// that value is older than STALE_MS. "?" when providers are on but none has a
// value, empty when none is on. The title (tooltip) has a line per enabled
// provider. entries: [{name, enabled, permitted, latest, lastOk}], one per
// provider with a collector — the same inputs as providerView(). "Leeway" is
// the brand (not translated); other words come from labels.
export function badgeView(entries, nowMs, timeZone, labels = {}) {
  const lines = [];
  let lowest = null;
  for (const entry of entries.filter(e => e.enabled)) {
    const shown = entry.permitted ? currentValues(entry.latest, entry.lastOk) : null;
    const limit = shown ? primaryLimit(shown.snapshot) : null;
    const status = providerView(entry, nowMs, timeZone, labels).status;
    if (!limit) {
      lines.push(`${entry.name}: ${status}`);
      continue;
    }
    const stale = isStale(shown.snapshot, nowMs);
    const reset = formatReset(limit, nowMs, timeZone, Date.parse(shown.snapshot.collected_at), labels);
    const note = shown.fromLastOk ? `${status} · ${labels.note_last_ok ?? ''}` : stale ? (labels.status_stale ?? '') : '';
    // "{limit} {remaining%}" so the tooltip can't read as usage, then the reset
    // and any note; the separator and the note brackets are per-locale (ja: 、 and
    // full-width brackets).
    const pctText = fill(labels.badge_pct || '{pct}', {pct: formatPercent(limit.remaining_percent)});
    const sep = labels.badge_sep || ' · ';
    const noteText = note ? fill(labels.badge_note_fmt || ' ({note})', {note}) : '';
    lines.push(`${entry.name}: ${limitLabel(limit, labels)} ${pctText}${reset ? `${sep}${reset}` : ''}${noteText}`);
    // Compared and coloured as shown: 49.6 is "50", green.
    const value = Math.round(limit.remaining_percent);
    if (!lowest || value < lowest.value) lowest = {value, stale};
  }
  if (!lines.length) return {text: '', color: BADGE_COLOR.grey, title: `Leeway — ${labels.badge_none ?? ''}`};
  const title = ['Leeway', ...lines].join('\n');
  if (!lowest) return {text: '?', color: BADGE_COLOR.grey, title};
  const color = lowest.stale ? BADGE_COLOR.grey
    : lowest.value >= 50 ? BADGE_COLOR.green : lowest.value >= 20 ? BADGE_COLOR.orange : BADGE_COLOR.red;
  return {text: String(lowest.value), color, title};
}
