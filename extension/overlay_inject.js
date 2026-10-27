// Injected into the active tab (chrome.scripting.executeScript, isolated world)
// when the user clicks "Open overlay" in the popup. Runs where chrome.* is
// available, opens a Document Picture-in-Picture window (always-on-top, no
// native app), and renders the same remaining-usage the popup shows — computed
// by background (view.js) via OVERLAY_DATA, refreshed on storage changes and
// on a timer. The PiP's opener is this page, so it lives while this tab does.
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
    body{margin:0;background:#0e1319;color:#e7ecf3;-webkit-font-smoothing:antialiased;
      font:12px/1.4 system-ui,-apple-system,"Segoe UI","Noto Sans KR","Noto Sans JP","Noto Sans SC","Noto Sans TC",sans-serif;padding:10px 12px}
    #ov .hd{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13px;margin-bottom:6px}
    #ov .st .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#3fca82;vertical-align:middle}
    #ov .st.partial .dot{background:#ecb23f}
    #ov .prov{margin:10px 0 0}
    #ov .prov.dim .lim{opacity:.5}
    #ov .pname{display:flex;justify-content:space-between;align-items:baseline;font-weight:600;font-size:12.5px}
    #ov .pstatus{font-size:10.5px;color:#8a97a8;font-weight:500}
    #ov .lim{position:relative;display:grid;grid-template-columns:1fr auto;gap:1px 8px;margin:6px 0 9px;padding-bottom:9px}
    #ov .lim .lb{grid-row:1;grid-column:1;font-size:10.5px;color:#8a97a8;align-self:center}
    #ov .lim .pc{grid-row:1;grid-column:2;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
    #ov .lim.primary .pc{font-size:16px;line-height:1}
    #ov .lim.good .pc{color:#3fca82}#ov .lim.warn .pc{color:#ecb23f}#ov .lim.bad .pc{color:#ff6168}
    #ov .lim .rs{grid-row:2;grid-column:1/-1;font-size:10px;color:#8a97a8;font-variant-numeric:tabular-nums}
    #ov .lim::after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;border-radius:3px;background:rgba(255,255,255,.11)}
    #ov .lim::before{content:"";position:absolute;left:0;bottom:0;height:4px;border-radius:3px;width:calc(var(--pct, 0) * 1%)}
    #ov .lim.good::before{background:#3fca82}#ov .lim.warn::before{background:#ecb23f}#ov .lim.bad::before{background:#ff6168}
    #ov .note{color:#8a97a8;font-size:10.5px;margin-top:1px}
    #ov .empty{color:#8a97a8;font-size:11.5px;text-align:center;padding:22px 6px}
    #ov .cline{display:flex;flex-wrap:wrap;align-items:center;gap:1px 7px;font-size:13px;padding:2px 0}
    #ov .cline .b{font-weight:800}
    #ov .cline .p{font-weight:700;font-variant-numeric:tabular-nums}
    #ov .cline .sep{color:#8a97a8}
    #ov .plan{margin-left:5px;font-size:10px;font-weight:600;color:#8a97a8}
    #ov .acct{margin-top:6px}
    #ov .aname{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;font-weight:600;color:#c3ccd8}
    body{cursor:pointer}`;

  const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tone = (pct) => { const n = parseInt(pct, 10); return Number.isFinite(n) ? (n < 20 ? 'bad' : n < 50 ? 'warn' : 'good') : ''; };
  const TONE_HEX = { good: '#3fca82', warn: '#ecb23f', bad: '#ff6168' };
  let collapsed = false;
  let lastData = { providers: [] };

  function renderRows(list) {
    return (list || []).map((r) => {
      const n = parseInt(r.percent, 10);
      const t = tone(r.percent);
      const pctStyle = Number.isFinite(n) ? ` style="--pct:${Math.max(0, Math.min(100, n))}"` : '';
      return `<div class="lim ${r.primary ? 'primary ' : ''}${t}"${pctStyle}>`
        + `<span class="lb">${esc(r.label)}</span><span class="pc">${esc(r.percent)}</span>`
        + (r.reset ? `<span class="rs">${esc(r.reset)}</span>` : '') + '</div>';
    }).join('');
  }

  // Several Claude organizations: one block each, named by its plan; the
  // provider line then carries no plan of its own.
  function renderProvider(p) {
    const name = NAMES[p.provider] || p.provider;
    const accounts = Array.isArray(p.accounts) ? p.accounts : [];
    const plan = p.plan && !accounts.length ? `<span class="plan">${esc(p.plan)}</span>` : '';
    const badge = p.state === 'ok' ? '' : `<span class="pstatus">${esc(p.status)}</span>`;
    const rows = accounts.length
      ? accounts.map((a) => `<div class="acct"><div class="aname"><span>${esc(a.label)}</span>`
        + (a.state === 'ok' ? '' : `<span class="pstatus">${esc(a.status)}</span>`) + `</div>${renderRows(a.rows)}</div>`).join('')
      : renderRows(p.rows);
    const note = p.note ? `<div class="note">${esc(p.note)}</div>` : '';
    return `<div class="prov${p.dim ? ' dim' : ''}"><div class="pname"><span>${esc(name)}${plan}</span>${badge}</div>${rows}${note}</div>`;
  }

  function render(root, data) {
    const provs = (data && data.providers || []).filter((p) => p.enabled);
    if (!provs.length) {
      const empty = (chrome.i18n && chrome.i18n.getMessage('overlay_empty')) || 'Turn on a service in the popup.';
      root.innerHTML = '<div class="hd"><span>Leeway</span></div><div class="empty">' + esc(empty) + '</div>';
      return;
    }
    const partial = provs.some((p) => p.dim);
    root.innerHTML = `<div class="hd"><span>Leeway</span><span class="st ${partial ? 'partial' : ''}"><span class="dot"></span></span></div>`
      + provs.map(renderProvider).join('');
  }

  // One-line "Leeway · Claude 72% · …" for the collapsed state.
  function renderCompact(host, data) {
    const provs = (data && data.providers || []).filter((p) => p.enabled && p.rows && p.rows.length);
    if (!provs.length) { render(host, data); return; }
    const part = (p) => {
      const r = p.rows.find((x) => x.primary) || p.rows[0];
      return `<span class="b">${esc(NAMES[p.provider] || p.provider)}</span> `
        + `<span class="p" style="color:${TONE_HEX[tone(r.percent)] || '#e7ecf3'}">${esc(r.percent)}</span>`;
    };
    host.innerHTML = '<div class="cline"><span class="b">Leeway</span><span class="sep">·</span>'
      + provs.map(part).join('<span class="sep">·</span>') + '</div>';
  }

  let pip;
  try {
    pip = await documentPictureInPicture.requestWindow({ width: 280, height: 240 });
  } catch (e) {
    console.warn('Leeway overlay: could not open PiP', e);
    return;
  }
  const doc = pip.document;
  doc.title = 'Leeway';
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
  const root = doc.createElement('div'); root.id = 'ov'; doc.body.appendChild(root);

  // Click the overlay to collapse to one line / expand; try to resize the PiP
  // window to match (resizeTo may be a no-op in some Chrome builds — harmless).
  const SIZE = { full: [280, 240], compact: [300, 58] };
  const resizePip = () => { try { pip.resizeTo(...(collapsed ? SIZE.compact : SIZE.full)); } catch (_) {} };
  const paint = () => (collapsed ? renderCompact : render)(root, lastData);
  root.addEventListener('click', () => { collapsed = !collapsed; resizePip(); paint(); });

  async function refresh() {
    try {
      lastData = (await chrome.runtime.sendMessage({ type: 'OVERLAY_DATA' })) || lastData;
      if (root.isConnected) paint();
    } catch (_) { /* background asleep between alarms; the next tick retries */ }
  }
  const onChanged = (changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k === 'enabledProviders' || k.startsWith('usage_'))) refresh();
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
