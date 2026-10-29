// What the floating overlay draws (CLAUDE.md §4), for the Leeway window
// (overlay_window.js) and the always-on-top Document Picture-in-Picture window
// it opens. Moved unchanged from overlay_inject.js, which drew the same in a
// PiP opened from the active tab (2026-10-28); tests/test_overlay.mjs pins the
// markup and the style.
//
// Layout: expanded = one block per service (name, plan, big main value, bar,
// then the main limit's reset and the other limits on one line); collapsed =
// one line of small rings, one per service. A click on the PiP window toggles
// between them. Text from storage goes through esc() (CLAUDE.md §3).
export const CSS = `
    html,body{margin:0;background:#0f141b}
    body{color:#e7ecf3;-webkit-font-smoothing:antialiased;cursor:pointer;overflow-y:auto;
      font:12px/1.4 "Segoe UI",system-ui,-apple-system,"Malgun Gothic","Noto Sans KR","Noto Sans JP","Noto Sans SC","Noto Sans TC",sans-serif}
    #ov{padding:12px 14px;display:flex;flex-direction:column;gap:12px;font-variant-numeric:tabular-nums}
    #ov .hd{display:flex;justify-content:space-between;align-items:center;gap:8px}
    #ov .brand{font-size:12px;font-weight:700;letter-spacing:.02em}
    #ov .muted{font-size:10.5px;color:#94a1b2}
    #ov .prov{display:flex;flex-direction:column;gap:5px}
    #ov .prov.dim{opacity:.55}
    #ov .top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
    #ov .name{display:flex;align-items:center;gap:6px;min-width:0;font-size:12.5px;font-weight:600}
    #ov .plan{font-size:10.5px;font-weight:600;color:#94a1b2;white-space:nowrap}
    #ov .chip{font-size:9.5px;font-weight:600;color:#e7ecf3;background:#283241;padding:1px 6px;border-radius:999px;white-space:nowrap}
    #ov .big{font-size:20px;font-weight:700;line-height:1}
    #ov .bar{height:4px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden}
    #ov .bar i{display:block;height:4px}
    #ov .sub{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;color:#94a1b2}
    #ov .sub b{font-weight:600}
    #ov .good{color:#3fca82}#ov .warn{color:#ecb23f}#ov .bad{color:#ff6168}
    #ov .bar i.good{background:#3fca82}#ov .bar i.warn{background:#ecb23f}#ov .bar i.bad{background:#ff6168}
    #ov .peer{display:flex;flex-direction:column;gap:12px;border-top:1px solid #283241;padding-top:10px}
    #ov .peerh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:11.5px;font-weight:700}
    #ov .empty{color:#94a1b2;font-size:11.5px;text-align:center;padding:22px 6px}
    #ov.compact{flex-direction:row;align-items:center;justify-content:space-between;gap:16px;padding:0 14px;min-height:100vh;box-sizing:border-box}
    #ov .ci{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;min-width:0}
    #ov .ci.dim{opacity:.55}
    #ov .ci b{font-weight:700}
    #ov .ci svg{flex:none}
    #ov.compact .empty{padding:0}`;

const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const TONE_HEX = { good: '#3fca82', warn: '#ecb23f', bad: '#ff6168' };
const RING = 2 * Math.PI * 10; // the collapsed ring's circumference (r = 10)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// "0%" is a value, "?" is none. Bars and rings are as long as the number shown
// (used or left); the colour is the row's tone (view.js toneOf), from what is
// left either way — the same as the popup and the badge. "?" has no tone.
const pctOf = (text) => { const n = parseInt(text, 10); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; };
const toneOfRow = (r) => (r && TONE_HEX[r.tone] ? r.tone : '');
const msg = (key, fallback) => { try { return chrome.i18n.getMessage(key) || fallback; } catch (_) { return fallback; } };
// Which way the numbers read, beside the brand when the data says (CLAUDE.md §4).
const MODE_KEYS = { used: 'mode_used', remaining: 'mode_left' };
let collapsed = false;
let lastData = { providers: [] };

// One service (or one Claude organization, or another profile's service).
// v: {name, plan, state, status, dim, rows, note}
function block(v) {
  const rows = Array.isArray(v.rows) ? v.rows : [];
  const main = rows.find((r) => r.primary) || rows[0];
  const chip = v.state && v.state !== 'ok' && v.status ? `<span class="chip">${esc(v.status)}</span>` : '';
  const plan = v.plan ? `<span class="plan">${esc(v.plan)}</span>` : '';
  const name = `<span class="name"><span>${esc(v.name)}</span>${plan}${chip}</span>`;
  const note = v.note && (!main || v.dim) ? `<div class="muted">${esc(v.note)}</div>` : '';
  if (!main) return `<div class="prov${v.dim ? ' dim' : ''}"><div class="top">${name}</div>${note}</div>`;
  const t = toneOfRow(main);
  const width = pctOf(main.percent) ?? 0;
  const left = [main.label, main.reset].filter(Boolean).map(esc).join(' · ');
  const right = rows.filter((r) => r !== main).slice(0, 2)
    .map((r) => `${esc(r.label)} <b class="${toneOfRow(r)}">${esc(r.percent)}</b>`).join(' · ');
  return `<div class="prov${v.dim ? ' dim' : ''}">`
    + `<div class="top">${name}<span class="big ${t}">${esc(main.percent)}</span></div>`
    + `<div class="bar"><i class="${t}" style="width:${width}%"></i></div>`
    + `<div class="sub"><span>${left}</span><span>${right}</span></div>${note}</div>`;
}

// A service with several Claude organizations: one block per organization,
// named "Claude" with the organization's plan beside it.
function serviceBlocks(p) {
  const name = NAMES[p.provider] || p.provider;
  const accounts = Array.isArray(p.accounts) ? p.accounts : [];
  if (!accounts.length) return block({ name, plan: p.plan, state: p.state, status: p.status, dim: p.dim, rows: p.rows, note: p.note });
  return accounts.map((a, i) => block({ name, plan: a.label, state: a.state, status: a.status, dim: p.dim, rows: a.rows, note: i === accounts.length - 1 ? p.note : '' })).join('');
}

export function render(root, data) {
  root.className = '';
  const provs = (data && data.providers || []).filter((p) => p.enabled);
  const peers = (data && Array.isArray(data.peers) ? data.peers : []).map((peer) => `<div class="peer"><div class="peerh"><span>${esc(peer.label)}</span>`
    + `<span class="muted">${esc(peer.updated)}</span></div>${(peer.providers || []).map(serviceBlocks).join('')}</div>`).join('');
  const modeKey = data && MODE_KEYS[data.mode];
  const mode = modeKey ? ` <span class="plan">${esc(msg(modeKey, ''))}</span>` : '';
  const head = `<div class="hd"><span class="brand">Leeway${mode}</span><span class="muted">${esc(data && data.checked)}</span></div>`;
  if (!provs.length && !peers) {
    root.innerHTML = head + `<div class="empty">${esc(msg('overlay_empty', 'Turn on a service in the popup.'))}</div>`;
    return;
  }
  root.innerHTML = head + provs.map(serviceBlocks).join('') + peers;
}

function ring(text, t) {
  const n = pctOf(text);
  const arc = n === null || !t ? '' : `<circle cx="12" cy="12" r="10" fill="none" stroke="${TONE_HEX[t]}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${(RING * n / 100).toFixed(1)} ${RING.toFixed(1)}" transform="rotate(-90 12 12)"></circle>`;
  return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="3.5"></circle>${arc}</svg>`;
}

// Collapsed: one ring + name + main value per service this profile has on.
// A service with nothing read yet still gets its place, as "?".
export function renderCompact(root, data) {
  root.className = 'compact';
  const provs = (data && data.providers || []).filter((p) => p.enabled).slice(0, 4);
  if (!provs.length) {
    root.innerHTML = `<div class="empty">${esc(msg('overlay_empty', 'Turn on a service in the popup.'))}</div>`;
    return;
  }
  root.innerHTML = provs.map((p) => {
    const rows = Array.isArray(p.rows) ? p.rows : [];
    const main = rows.find((r) => r.primary) || rows[0];
    const pct = main ? main.percent : '?';
    const t = toneOfRow(main);
    return `<span class="ci${p.dim ? ' dim' : ''}">${ring(pct, t)}<span>${esc(NAMES[p.provider] || p.provider)}</span>`
      + `<b class="${t === 'good' ? '' : t}">${esc(pct)}</b></span>`;
  }).join('');
}

// Click to collapse to one line / expand. The window follows:
//   collapsed — a fixed strip, COMPACT_W wide and COMPACT_H of content;
//   expanded  — EXPANDED_W wide, as tall as its content between
//               EXPANDED_MIN_H and EXPANDED_MAX_H (more than that scrolls).
// Heights are content heights; Chrome's title bar is added on top. Chrome
// lets the user resize a PiP window at any time and offers no way to stop
// it: these sizes are applied on open and on every click. resizeTo needs
// the click's user activation and may be a no-op in some Chrome builds.
const COMPACT_W = 360;
const COMPACT_H = 44;
const EXPANDED_W = 280;
const EXPANDED_MIN_H = 140;
const EXPANDED_MAX_H = 520;
const OPEN_H = 270; // when the content could not be measured: three services fit

// How tall the expanded overlay is for `data` at the width the PiP opens
// with, measured in `doc` — the opener's own page, which has the same style
// (CSS) — in a hidden copy that is removed again. The PiP then opens at that
// height: once requestWindow() has spent the click's activation, resizeTo()
// does nothing, so the window can't be fitted after it opens.
function openingHeight(doc, data) {
  if (!doc?.body) return OPEN_H;
  const probe = doc.createElement('div');
  probe.id = 'ov';
  probe.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;width:${EXPANDED_W}px;box-sizing:border-box`;
  doc.body.appendChild(probe);
  try {
    render(probe, data);
    const content = probe.scrollHeight;
    return content ? Math.min(EXPANDED_MAX_H, Math.max(EXPANDED_MIN_H, content)) : OPEN_H;
  } finally {
    probe.remove();
  }
}

// Opens the always-on-top window with `data` drawn in it, expanded, as tall
// as that content when `measureIn` (the opener's document) is given. Call it
// from a click: requestWindow() needs the user activation.
// Returns {window, show(data)}, or null when Chrome would not open it.
export async function openPip(documentPictureInPicture, data, measureIn = null) {
  let pip;
  try {
    // preferInitialWindowPlacement: open at this size every time — without it
    // Chrome reopens at the size and place the window last had (e.g. one the
    // user dragged bigger) and ignores width/height.
    pip = await documentPictureInPicture.requestWindow({ width: EXPANDED_W, height: openingHeight(measureIn, data), preferInitialWindowPlacement: true });
  } catch (e) {
    console.warn('Leeway overlay: could not open PiP', e);
    return null;
  }
  const doc = pip.document;
  doc.title = 'Leeway';
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
  const root = doc.createElement('div'); root.id = 'ov'; doc.body.appendChild(root);
  let collapsed = false;
  let lastData = { providers: [] };

  function resizePip() {
    try {
      const frame = Math.max(0, (pip.outerHeight || 0) - (pip.innerHeight || 0));
      if (collapsed) { pip.resizeTo(COMPACT_W, COMPACT_H + frame); return; }
      const content = root.scrollHeight || 240;
      pip.resizeTo(EXPANDED_W, Math.min(EXPANDED_MAX_H, Math.max(EXPANDED_MIN_H, content)) + frame);
    } catch (_) {}
  }
  const paint = () => (collapsed ? renderCompact : render)(root, lastData);
  root.addEventListener('click', () => { collapsed = !collapsed; paint(); resizePip(); });

  const show = (next) => { lastData = next || lastData; if (root.isConnected) paint(); };
  // Already opened at the content's height (openingHeight). Fitting it here as
  // well only takes where a Chrome build still allows resizeTo.
  show(data);
  resizePip();
  return { window: pip, show };
}
