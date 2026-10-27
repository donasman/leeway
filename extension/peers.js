// Pure functions — no chrome.*, no fetch, no document.
// "Other Chrome profiles": each profile's Leeway sends its own normalized
// usage to the Leeway helper (Native Messaging) and gets the other profiles'
// back. Only what the popup already shows goes out — remaining percent, reset
// time, plan — never cookies, tokens, page text or a detail string.
// Imported by background.js and tests/test_peers.mjs.
import { currentValues, fill, formatAge } from './view.js';

export const HELPER_HOST = 'com.leeway.helper';
export const PEER_PERMISSION = {permissions: ['nativeMessaging']};
// The helper refuses more than 16 KB of snapshots; stay under it.
const MAX_SHARED_BYTES = 15000;
const PEER_ID = /^[a-f0-9]{16,32}$/;

// The name this profile shows to the others ("업무용"). Empty is allowed: the
// helper then names it "Chrome".
export function cleanLabel(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) : '';
}

// A random id for this profile (the helper keys entries by it). Not tied to
// any account: only to this profile's Leeway install.
export function newProfileId(randomBytes) {
  return [...randomBytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// What this profile shares: for each enabled provider, the values the popup
// shows (latest ok, else last ok), without the detail text. Claude's account
// list goes first when the total would be too large.
export function sharedSnapshots(entries) {
  const out = [];
  for (const {latest, lastOk} of entries) {
    const shown = currentValues(latest, lastOk);
    if (!shown) continue;
    const {detail, ...snapshot} = shown.snapshot;
    out.push(snapshot);
  }
  if (JSON.stringify(out).length > MAX_SHARED_BYTES) out.forEach(snapshot => delete snapshot.accounts);
  return JSON.stringify(out).length > MAX_SHARED_BYTES ? [] : out;
}

// Chrome's errors (chrome.runtime.lastError), as a code the popup can explain.
// The raw text is not kept. Chromium's wording (native_message_host.cc,
// message_service.cc):
// - "Specified native messaging host not found." — no registry entry, or the
//   manifest is missing, unreadable, misnamed, or points at a missing exe
// - "Access to the specified native messaging host is forbidden." — this
//   extension's origin is not in allowed_origins
// - "Access to the native messaging host was disabled by the system
//   administrator." — a NativeMessagingBlocklist/Allowlist policy
// - anything else ("Failed to start…", "Native host has exited.", "Error when
//   communicating…", an error the helper itself answered with, no answer)
export function helperError(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('not found')) return 'helper_missing';
  if (text.includes('forbidden')) return 'helper_forbidden';
  if (text.includes('system administrator')) return 'helper_blocked';
  return 'helper_failed';
}

// The oldest helper this Leeway works with. Released helpers before 0.6.3
// report "0.1.0" and have no "check" command; a build from source reports
// "dev" and is never too old.
export const MIN_HELPER_VERSION = '0.6.3';
const HELPER_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

// The helper's version as reported, if it is one: "x.y.z" or "dev".
export function helperVersion(value) {
  return typeof value === 'string' && (value === 'dev' || HELPER_VERSION.test(value)) ? value : null;
}

// true when the helper is older than MIN_HELPER_VERSION, or reported no
// version that can be compared.
export function helperOutdated(version, min = MIN_HELPER_VERSION) {
  if (version === 'dev') return false;
  const have = HELPER_VERSION.exec(version ?? '');
  const need = HELPER_VERSION.exec(min);
  if (!have || !need) return true;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(have[i]) !== Number(need[i])) return Number(have[i]) < Number(need[i]);
  }
  return false;
}

// What is stored after a helper round trip: the other profiles only, each
// entry shape-checked (view.js checks every value again when it shows them),
// and the helper's version when it answered.
export function peerRecord(reply, selfId, nowMs) {
  const at = new Date(nowMs).toISOString();
  const version = helperVersion(reply?.version);
  if (!reply || reply.ok !== true) return {at, ok: false, error: helperError(reply?.error), version, profiles: []};
  const profiles = (Array.isArray(reply.profiles) ? reply.profiles : [])
    .filter(p => p && typeof p.id === 'string' && PEER_ID.test(p.id) && p.id !== selfId && Array.isArray(p.snapshots))
    .slice(0, 8)
    .map(p => ({id: p.id, label: typeof p.label === 'string' ? p.label : '', updated_at: typeof p.updated_at === 'string' ? p.updated_at : '', snapshots: p.snapshots}));
  return {at, ok: true, error: null, version, profiles};
}

// What the popup says about the helper: a state, and for each the message
// keys of one line on the cause and one on what to do. A record saved before
// versions were kept (no version key) is not judged until the next sync.
export function helperState(record) {
  if (!record) return {state: 'waiting', lines: []};
  if (!record.ok) {
    const state = ['helper_missing', 'helper_forbidden', 'helper_blocked'].includes(record.error) ? record.error : 'helper_failed';
    return {state, lines: [`peers_${state}_cause`, `peers_${state}_action`]};
  }
  if ('version' in record && helperOutdated(record.version)) return {state: 'helper_outdated', lines: ['peers_helper_outdated_cause', 'peers_helper_outdated_action']};
  return {state: 'ok', lines: ['version' in record ? 'peers_helper_ok' : null].filter(Boolean)};
}

// helperState() as the text the popup shows, from the labels map (i18n.js).
// extensionId fills the --extension-id hint for an unpacked copy.
export function helperNote(record, nowMs, labels = {}, extensionId = '') {
  const {state, lines} = helperState(record);
  const vars = {version: record?.version ?? '?', min: MIN_HELPER_VERSION, id: extensionId, age: formatAge(nowMs - Date.parse(record?.at), labels)};
  return {state, lines: lines.map(key => fill(labels[key], vars))};
}
