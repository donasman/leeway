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

// ---- plan labels -------------------------------------------------------------
// The plan is shown as a short product name, never as server text: each label
// comes from this fixed list, so nothing the service sends ends up on screen.
// Checked against a logged-in claude.ai on 2026-10-27: a Max 5x organization
// has capabilities ["chat", "claude_max"] and rate_limit_tier
// "default_claude_max_5x". The Pro, Team and Enterprise markers below follow
// the same naming but were not seen in a live response.
export function claudePlanLabel(org) {
  const caps = Array.isArray(org?.capabilities) ? org.capabilities : [];
  const tier = typeof org?.rate_limit_tier === 'string' ? org.rate_limit_tier : '';
  if (caps.includes('claude_max')) {
    const times = /max_(5|20)x/.exec(tier);
    return times ? `Max ${times[1]}x` : 'Max';
  }
  if (caps.includes('claude_pro')) return 'Pro';
  if (org?.raven_type === 'team') return 'Team';
  if (org?.raven_type === 'enterprise') return 'Enterprise';
  return null;
}

// ChatGPT's wham/usage plan_type. "free" was seen in a live response on
// 2026-10-27; the others are the plan names ChatGPT sells. An unknown value
// shows no label rather than a guess.
const CHATGPT_PLANS = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team',
  business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
};
export function chatgptPlanLabel(planType) {
  return typeof planType === 'string' ? CHATGPT_PLANS[planType.toLowerCase()] ?? null : null;
}
