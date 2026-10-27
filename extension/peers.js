// Pure functions — no chrome.*, no fetch, no document.
// "Other Chrome profiles": each profile's Leeway sends its own normalized
// usage to the Leeway helper (Native Messaging) and gets the other profiles'
// back. Only what the popup already shows goes out — remaining percent, reset
// time, plan — never cookies, tokens, page text or a detail string.
// Imported by background.js and tests/test_peers.mjs.
import { currentValues } from './view.js';

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

// Chrome's errors, as a code the popup can explain. The raw text is not kept.
export function helperError(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('not found')) return 'helper_missing';
  if (text.includes('forbidden')) return 'helper_forbidden';
  return 'helper_failed';
}

// What is stored after a helper round trip: the other profiles only, each
// entry shape-checked (view.js checks every value again when it shows them).
export function peerRecord(reply, selfId, nowMs) {
  const at = new Date(nowMs).toISOString();
  if (!reply || reply.ok !== true) return {at, ok: false, error: helperError(reply?.error), profiles: []};
  const profiles = (Array.isArray(reply.profiles) ? reply.profiles : [])
    .filter(p => p && typeof p.id === 'string' && PEER_ID.test(p.id) && p.id !== selfId && Array.isArray(p.snapshots))
    .slice(0, 8)
    .map(p => ({id: p.id, label: typeof p.label === 'string' ? p.label : '', updated_at: typeof p.updated_at === 'string' ? p.updated_at : '', snapshots: p.snapshots}));
  return {at, ok: true, error: null, profiles};
}
