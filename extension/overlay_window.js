// The Leeway window (CLAUDE.md §4). The popup's "Open overlay" has background
// open it (or bring the open one forward). It shows the expanded overlay
// itself, in an ordinary window that others can cover, and its "Always on top"
// button opens the Document Picture-in-Picture overlay from here. Being an
// extension page, it works whatever tab is in front (the Web Store, chrome://
// pages), injects into no tab, and the PiP's title bar shows the extension's
// name and address, not a site's. The PiP lives as long as this window:
// closing the window closes it.
// Once the PiP is open this window minimizes; closing the PiP brings it back.
import { usageKey, lastOkKey } from './snapshot.js';
import { formatAge, peerViews, providerView } from './view.js';
import { msg, viewLabels } from './i18n.js';
import { CSS, openPip, render } from './overlay_view.js';

const PROVIDER_HOSTS = {claude:'https://claude.ai/*', chatgpt:'https://chatgpt.com/*', gemini:'https://gemini.google.com/*'};
const root = document.getElementById('ov');
const pinButton = document.getElementById('pin');
let lastData = { providers: [] };
let pip = null; // the always-on-top overlay while it is open: {window, show}

// Both draw the same values: this window always expanded, the PiP as the user
// left it (collapsed or not).
function paint() {
  render(root, lastData);
  if (pip) pip.show(lastData);
}

async function hasHostPermission(provider) {
  const host = PROVIDER_HOSTS[provider];
  if (!host) return false;
  try { return await chrome.permissions.contains({origins:[host]}); }
  catch (_) { return false; }
}

// What the overlay draws: one providerView per provider, built the way the
// popup builds it, so the two always match. Read from storage here, by this
// extension page (no message to background); the clock is read at each call,
// so a timer Chrome runs late shows the right age, only later.
async function overlayData() {
  const labels = viewLabels();
  const enabled = new Set((await chrome.storage.local.get(['enabledProviders'])).enabledProviders || []);
  const now = Date.now();
  const providers = [];
  let newest = NaN; // the latest read of any service that is on, for the header
  for (const provider of Object.keys(PROVIDER_HOSTS)) {
    const on = enabled.has(provider);
    const permitted = on && await hasHostPermission(provider);
    const stored = await chrome.storage.local.get([usageKey(provider), lastOkKey(provider)]);
    const readAt = Date.parse(stored[usageKey(provider)]?.collected_at);
    if (permitted && Number.isFinite(readAt) && !(readAt <= newest)) newest = readAt;
    const view = providerView({enabled: on, permitted, latest: stored[usageKey(provider)], lastOk: stored[lastOkKey(provider)]}, now, undefined, labels);
    providers.push({provider, enabled: on, state: view.state, status: view.status, rows: view.rows, dim: view.dim, note: view.note, plan: view.plan, accounts: view.accounts});
  }
  const {peer_settings: settings, peer_profiles: record} = await chrome.storage.local.get(['peer_settings', 'peer_profiles']);
  const peers = settings?.on ? peerViews(record, now, undefined, labels) : [];
  const age = Number.isFinite(newest) ? formatAge(now - newest, labels) : '';
  const checked = age ? String(labels.checked || '').replace('{age}', age) : '';
  return {providers, peers, checked, now};
}

// Storage changes and the clock tick can overlap; only the newest one paints.
let refreshes = 0;
async function refresh() {
  const current = ++refreshes;
  let data = null;
  try { data = await overlayData(); }
  catch (error) { console.warn('Leeway window: values not read:', String(error)); }
  if (current !== refreshes) return;
  lastData = data || lastData;
  paint();
}

// This window: minimized while the PiP is up, brought back when it closes.
// Only as a popup window — the page opened in an ordinary tab leaves that
// browser window alone.
const ownWindow = chrome.windows.getCurrent().catch(() => null);
async function setOwnState(state) {
  const win = await ownWindow;
  if (win?.type !== 'popup') return;
  try { await chrome.windows.update(win.id, state === 'minimized' ? { state } : { state, focused: true }); }
  catch (_) { /* the window is closing */ }
}

// Already open (this window was brought back from the popup): no second one,
// this window just steps aside again.
pinButton.addEventListener('click', async () => {
  if (!documentPictureInPicture.window) {
    const opened = await openPip(documentPictureInPicture, lastData, document);
    if (!opened) return;
    pip = opened;
    // Closed with its X or its "back to tab" button — or by Chrome: this
    // window comes back, so the values stay in sight.
    opened.window.addEventListener('pagehide', () => {
      if (pip === opened) pip = null;
      setOwnState('normal');
    });
  }
  await setOwnState('minimized');
});
// Chrome before 116 has no Document Picture-in-Picture: this window only.
if (!('documentPictureInPicture' in window)) pinButton.hidden = true;

// Where the user leaves this window, for the next time background opens it.
// Only its normal state: minimized (while the PiP is up) or maximized bounds
// are no place to reopen at.
chrome.windows.onBoundsChanged.addListener(async (win) => {
  const own = await ownWindow;
  if (!own || win?.id !== own.id || win.type !== 'popup' || win.state !== 'normal') return;
  const bounds = { left: win.left, top: win.top, width: win.width, height: win.height };
  if (!Object.values(bounds).every(Number.isInteger)) return;
  try { await chrome.storage.local.set({ overlay_window_bounds: bounds }); }
  catch (_) {}
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k === 'enabledProviders' || k.startsWith('usage_') || k.startsWith('peer_'))) refresh();
});
// "3분 전", staleness and the reset countdowns move with the clock, not only
// with storage. While the PiP is up this page is minimized, and Chrome may run
// a hidden page's timers late (up to a minute); each paint reads the clock anew.
setInterval(refresh, 30 * 1000);

document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
const style = document.createElement('style'); style.textContent = CSS; document.head.prepend(style);
paint();
refresh();
