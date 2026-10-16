// Pure functions — no chrome.*, no fetch, no document.
// Imported by background.js (ES module service worker) and tests/test_parsers.mjs.

export function clampPct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}
export function fmtReset(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
}
export function pickClaudeBuckets(usage) {
  const mapped = {};
  if (Array.isArray(usage?.limits)) {
    for (const x of usage.limits) {
      if (!x) continue;
      const entry = {utilization:x.percent, resets_at:x.resets_at};
      if (x.kind === 'session') mapped.session = entry;
      else if (x.kind === 'weekly_all') mapped.weekly = entry;
    }
  }
  return {
    session: mapped.session || usage?.five_hour || null,
    weekly: mapped.weekly || usage?.seven_day || null
  };
}
