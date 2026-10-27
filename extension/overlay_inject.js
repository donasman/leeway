// Injected into the active tab (chrome.scripting.executeScript, isolated world)
// when the user clicks "Open overlay" in the popup. Runs where chrome.* is
// available, opens a Document Picture-in-Picture window (always-on-top, no
// native app), and renders the same remaining-usage the popup shows — computed
// by background (view.js) via OVERLAY_DATA, refreshed on storage changes and
// on a timer. The PiP's opener is this page, so it lives while this tab does.
//
// Layout: expanded = one block per service (name, plan, big main value, bar,
// then the main limit's reset and the other limits on one line); collapsed =
// one line of small rings, one per service. Click toggles between them.
(async () => {
  'use strict';
  if (!('documentPictureInPicture' in window)) {
    console.warn('Leeway overlay: this Chrome has no Document Picture-in-Picture (needs 116+).');
    return;
  }
  // Already open (e.g. the button was clicked twice): focus it, don't stack.
  if (documentPictureInPicture.window) {
    try { documentPictureInPicture.window.focus(); } catch (_) {}
    return;
  }

  const CSS = `
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
    #ov.compact{flex-direction:row;align-items:center;justify-content:space-between;gap:8px;padding:0 12px;min-height:100vh;box-sizing:border-box}
    #ov .ci{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;min-width:0}
    #ov .ci.dim{opacity:.55}
    #ov .ci b{font-weight:700}
    #ov .ci svg{flex:none}
    #ov.compact .empty{padding:0}`;

  const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
  const TONE_HEX = { good: '#3fca82', warn: '#ecb23f', bad: '#ff6168' };
  const RING = 2 * Math.PI * 10; // the collapsed ring's circumference (r = 10)
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // "0%" is a value (red), "?" is none (no colour) — same thresholds as the popup and badge.
  const pctOf = (text) => { const n = parseInt(text, 10); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; };
  const tone = (text) => { const n = pctOf(text); return n === null ? '' : n < 20 ? 'bad' : n < 50 ? 'warn' : 'good'; };
  const msg = (key, fallback) => { try { return chrome.i18n.getMessage(key) || fallback; } catch (_) { return fallback; } };
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
    const t = tone(main.percent);
    const width = pctOf(main.percent) ?? 0;
    const left = [main.label, main.reset].filter(Boolean).map(esc).join(' · ');
    const right = rows.filter((r) => r !== main).slice(0, 2)
      .map((r) => `${esc(r.label)} <b class="${tone(r.percent)}">${esc(r.percent)}</b>`).join(' · ');
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

  function render(root, data) {
    root.className = '';
    const provs = (data && data.providers || []).filter((p) => p.enabled);
    const peers = (data && Array.isArray(data.peers) ? data.peers : []).map((peer) => `<div class="peer"><div class="peerh"><span>${esc(peer.label)}</span>`
      + `<span class="muted">${esc(peer.updated)}</span></div>${(peer.providers || []).map(serviceBlocks).join('')}</div>`).join('');
    const head = `<div class="hd"><span class="brand">Leeway</span><span class="muted">${esc(data && data.checked)}</span></div>`;
    if (!provs.length && !peers) {
      root.innerHTML = head + `<div class="empty">${esc(msg('overlay_empty', 'Turn on a service in the popup.'))}</div>`;
      return;
    }
    root.innerHTML = head + provs.map(serviceBlocks).join('') + peers;
  }

  function ring(text) {
    const n = pctOf(text);
    const arc = n === null ? '' : `<circle cx="12" cy="12" r="10" fill="none" stroke="${TONE_HEX[tone(text)]}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${(RING * n / 100).toFixed(1)} ${RING.toFixed(1)}" transform="rotate(-90 12 12)"></circle>`;
    return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="3.5"></circle>${arc}</svg>`;
  }

  // Collapsed: one ring + name + main value per service this profile has on.
  // A service with nothing read yet still gets its place, as "?".
  function renderCompact(root, data) {
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
      const t = tone(pct);
      // Digits only, like the toolbar badge: three services fit in 300 px even at 100.
      const shown = pctOf(pct) === null ? '?' : String(pctOf(pct));
      return `<span class="ci${p.dim ? ' dim' : ''}">${ring(pct)}<span>${esc(NAMES[p.provider] || p.provider)}</span>`
        + `<b class="${t === 'good' ? '' : t}">${esc(shown)}</b></span>`;
    }).join('');
  }

  let pip;
  try {
    pip = await documentPictureInPicture.requestWindow({ width: 280, height: 270 }); // three services fit
  } catch (e) {
    console.warn('Leeway overlay: could not open PiP', e);
    return;
  }
  const doc = pip.document;
  doc.title = 'Leeway';
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
  const root = doc.createElement('div'); root.id = 'ov'; doc.body.appendChild(root);

  // Click to collapse to one line / expand. The window follows: collapsed is a
  // fixed strip; expanded fits its content up to 560 px (then it scrolls).
  // resizeTo needs the click's user activation and may be a no-op in some
  // Chrome builds — harmless either way.
  const COMPACT = [300, 58];
  const WIDTH = 280;
  function resizePip() {
    try {
      if (collapsed) { pip.resizeTo(...COMPACT); return; }
      const frame = Math.max(0, (pip.outerHeight || 0) - (pip.innerHeight || 0));
      const content = root.scrollHeight;
      pip.resizeTo(WIDTH, content > 0 ? Math.min(560, Math.max(120, content + frame)) : 270);
    } catch (_) {}
  }
  const paint = () => (collapsed ? renderCompact : render)(root, lastData);
  root.addEventListener('click', () => { collapsed = !collapsed; paint(); resizePip(); });

  async function refresh() {
    try {
      lastData = (await chrome.runtime.sendMessage({ type: 'OVERLAY_DATA' })) || lastData;
      if (root.isConnected) paint();
    } catch (_) { /* background asleep between alarms; the next tick retries */ }
  }
  const onChanged = (changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k === 'enabledProviders' || k.startsWith('usage_') || k.startsWith('peer_'))) refresh();
  };
  chrome.storage.onChanged.addListener(onChanged);
  const timer = setInterval(refresh, 30 * 1000); // keep "N min ago" / staleness current

  pip.addEventListener('pagehide', () => {
    clearInterval(timer);
    try { chrome.storage.onChanged.removeListener(onChanged); } catch (_) {}
  });

  paint(); // first paint while the message round-trips
  refresh(); // background's 2-min alarm keeps the stored values fresh after this
})();
