import { usageKey, lastOkKey } from './snapshot.js';
import { peerViews, providerView } from './view.js';
import { viewLabels, msg } from './i18n.js';
import { helperNote } from './peers.js';

const PROVIDER_HOSTS = {claude:'https://claude.ai/*', chatgpt:'https://chatgpt.com/*', gemini:'https://gemini.google.com/*'};
const POPUP_PROVIDERS = Object.keys(PROVIDER_HOSTS);
const PROVIDER_NAMES = {claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini'};
const PEER_PERMISSION = {permissions: ['nativeMessaging']};
const LABELS = viewLabels();
const REFRESH_TEXT = msg('refresh');
const REFUSED_NOTE = msg('refused_note');

// Toggles in flight: render() leaves their checkbox as the user set it, so a
// render while the permission prompt is open doesn't flip it back.
const toggling = new Set();
// Permission refused: say so until the next toggle of that provider.
const refused = new Set();

async function hasHostPermission(provider) {
  const host = PROVIDER_HOSTS[provider];
  if (!host) return false;
  try { return await chrome.permissions.contains({origins:[host]}); }
  catch (_) { return false; }
}

function limitRow(row) {
  const line = document.createElement('div');
  line.className = row.primary ? 'limit primary' : 'limit';
  // Bar width and colour come from the remaining percent; "?" (no value) leaves
  // --pct unset (fill 0, no tone). Thresholds match the toolbar badge colours.
  const remaining = parseInt(row.percent, 10);
  if (Number.isFinite(remaining)) {
    line.style.setProperty('--pct', String(Math.max(0, Math.min(100, remaining))));
    line.classList.add(remaining < 20 ? 'bad' : remaining < 50 ? 'warn' : 'good');
  }
  for (const [name, text] of [['label', row.label], ['pct', row.percent], ['reset', row.reset]]) {
    const cell = document.createElement('span');
    cell.className = name;
    cell.textContent = text; // labels and reset_text come from web pages: text, never HTML
    line.append(cell);
  }
  return line;
}

// One Claude organization: its name (the plan, e.g. "Max 5x"), its status when
// it is not ok, and its rows.
function accountBlock(account) {
  const block = document.createElement('div');
  block.className = 'account';
  const head = document.createElement('div');
  head.className = 'account-name';
  const name = document.createElement('span');
  name.textContent = account.label;
  head.append(name);
  if (account.state !== 'ok') {
    const status = document.createElement('span');
    status.className = `badge ${account.state}`;
    status.textContent = account.status;
    head.append(status);
  }
  block.append(head, ...account.rows.map(limitRow));
  return block;
}

function showProvider(provider, view) {
  const status = document.getElementById(`status_${provider}`);
  status.textContent = view.status;
  status.className = `badge ${view.state}`;
  status.title = view.detail;
  const accounts = Array.isArray(view.accounts) ? view.accounts : [];
  // With several organizations each names its own plan; the header shows none.
  const plan = document.getElementById(`plan_${provider}`);
  if (plan) plan.textContent = accounts.length ? '' : (view.plan || '');
  const limits = document.getElementById(`limits_${provider}`);
  limits.replaceChildren(...(accounts.length ? accounts.map(accountBlock) : view.rows.map(limitRow)));
  limits.classList.toggle('dim', view.dim);
  document.getElementById(`note_${provider}`).textContent = view.note;
}

// Another profile's service: its name and plan, its status when not ok, and
// its rows (or one block per Claude organization).
function peerProviderBlock(view) {
  const block = document.createElement('div');
  block.className = view.dim ? 'peer-provider dim' : 'peer-provider';
  const head = document.createElement('div');
  head.className = 'peer-name';
  const name = document.createElement('span');
  name.textContent = [PROVIDER_NAMES[view.provider] || view.provider, view.accounts.length ? '' : view.plan].filter(Boolean).join(' · ');
  head.append(name);
  if (view.state !== 'ok') {
    const status = document.createElement('span');
    status.className = `badge ${view.state}`;
    status.textContent = view.status;
    head.append(status);
  }
  block.append(head, ...(view.accounts.length ? view.accounts.map(accountBlock) : view.rows.map(limitRow)));
  return block;
}

function peerBlock(peer) {
  const block = document.createElement('div');
  block.className = 'peer';
  const head = document.createElement('div');
  head.className = 'peer-head';
  const name = document.createElement('span');
  name.textContent = peer.label; // another profile's name: text, never HTML
  const updated = document.createElement('span');
  updated.className = 'muted';
  updated.textContent = peer.updated;
  head.append(name, updated);
  block.append(head, ...peer.providers.map(peerProviderBlock));
  return block;
}

function showPeers(settings, record, now) {
  const on = Boolean(settings?.on);
  if (!toggling.has('peers')) document.getElementById('toggle_peers').checked = on;
  document.getElementById('peer_setup').hidden = !on;
  const input = document.getElementById('peer_label');
  if (document.activeElement !== input) input.value = on && typeof settings.label === 'string' ? settings.label : '';
  const peers = on ? peerViews(record, now, undefined, LABELS) : [];
  document.getElementById('peers_list').replaceChildren(...peers.map(peerBlock));
  const status = document.getElementById('status_peers');
  let note = '';
  // One line on the cause and one on what to do (CLAUDE.md §2 Leeway helper).
  const helper = on ? helperNote(record, now, LABELS, chrome.runtime.id || '') : {state: 'off', lines: []};
  if (!on) {
    status.textContent = LABELS.status_off;
    status.className = 'badge off';
    note = refused.has('peers') ? REFUSED_NOTE : msg('peers_hint');
  } else if (!record) {
    status.textContent = LABELS.status_waiting;
    status.className = 'badge waiting';
  } else if (!record.ok) {
    status.textContent = LABELS.status_parse_failed;
    status.className = 'badge parse_failed';
    note = helper.lines.join('\n');
  } else {
    status.textContent = String(peers.length);
    status.className = 'badge ok';
    note = [peers.length ? '' : msg('peers_none'), ...helper.lines].filter(Boolean).join('\n');
  }
  document.getElementById('note_peers').textContent = note;
  // Experimental: folded away until it is on (then it stays open). The
  // download and "what it does" links show while it is off or failing.
  if (on) document.getElementById('labs').open = true;
  document.getElementById('peer_links').hidden = on && helper.state === 'ok';
}

// Storage changes, the clock tick and toggles can overlap; only the newest
// render writes to the page.
let renders = 0;
async function render() {
  const current = ++renders;
  const keys = ['enabledProviders', 'peer_settings', 'peer_profiles', ...POPUP_PROVIDERS.flatMap(p => [usageKey(p), lastOkKey(p)])];
  const data = await chrome.storage.local.get(keys);
  const enabled = new Set(Array.isArray(data.enabledProviders) ? data.enabledProviders : []);
  const permitted = await Promise.all(POPUP_PROVIDERS.map(p => enabled.has(p) && hasHostPermission(p)));
  if (current !== renders) return;
  const now = Date.now();
  POPUP_PROVIDERS.forEach((provider, i) => {
    // One provider's odd stored data must not keep the others from showing.
    try {
      const on = enabled.has(provider);
      if (!toggling.has(provider)) document.getElementById(`toggle_${provider}`).checked = on;
      const view = providerView({
        enabled: on, permitted: permitted[i],
        latest: data[usageKey(provider)], lastOk: data[lastOkKey(provider)],
      }, now, undefined, LABELS);
      showProvider(provider, !on && refused.has(provider) ? {...view, note: REFUSED_NOTE} : view);
    } catch (error) {
      console.warn(`popup: ${provider} not shown:`, String(error));
    }
  });
  try { showPeers(data.peer_settings, data.peer_profiles, now); }
  catch (error) { console.warn('popup: other profiles not shown:', String(error)); }
}

// Called before anything else in the click handler: it needs the click's user gesture.
function askPermission(host) {
  try { return chrome.permissions.request({origins:[host]}).catch(() => false); }
  catch (_) { return Promise.resolve(false); }
}

// background owns enabledProviders (CLAUDE.md §2): it turns a provider on —
// also from permissions.onAdded, in case Chrome closed this popup while the
// prompt was open — and off (out of enabledProviders, 'disabled' saved, site
// permission removed).
async function handleToggle(provider, event) {
  const checkbox = event.target;
  const host = PROVIDER_HOSTS[provider];
  if (!host) return;
  const asked = checkbox.checked ? askPermission(host) : null;
  // One toggle at a time: a second click before background is done would race
  // it (e.g. off, then on while the permission is still being removed).
  checkbox.disabled = true;
  toggling.add(provider);
  refused.delete(provider);
  try {
    if (!asked) {
      try { await chrome.runtime.sendMessage({type:'PROVIDER_DISABLED', provider}); }
      catch (_) {}
    } else if (await asked) {
      try { await chrome.runtime.sendMessage({type:'PROVIDER_ENABLED', provider}); }
      catch (_) {}
    } else {
      refused.add(provider);
    }
  } finally {
    toggling.delete(provider);
    checkbox.disabled = false;
  }
  await render();
}

// Other Chrome profiles: the nativeMessaging permission is asked for here, in
// the click (it needs the user gesture); background turns it on — also from
// permissions.onAdded, in case Chrome closed this popup during the prompt.
async function handlePeersToggle(event) {
  const checkbox = event.target;
  let asked = null;
  if (checkbox.checked) {
    try { asked = chrome.permissions.request(PEER_PERMISSION).catch(() => false); }
    catch (_) { asked = Promise.resolve(false); }
  }
  checkbox.disabled = true;
  toggling.add('peers');
  refused.delete('peers');
  try {
    if (!asked) {
      try { await chrome.runtime.sendMessage({type:'PEERS_DISABLE'}); }
      catch (_) {}
    } else if (await asked) {
      try { await chrome.runtime.sendMessage({type:'PEERS_ENABLE', label: document.getElementById('peer_label').value}); }
      catch (_) {}
    } else {
      refused.add('peers');
    }
  } finally {
    toggling.delete('peers');
    checkbox.disabled = false;
  }
  await render();
}
document.getElementById('toggle_peers').addEventListener('change', handlePeersToggle);
document.getElementById('peer_label').addEventListener('change', async event => {
  try { await chrome.runtime.sendMessage({type:'PEERS_LABEL', label: event.target.value}); }
  catch (_) {}
});
document.getElementById('peer_label').placeholder = msg('peers_label_placeholder');

document.getElementById('toggle_claude').addEventListener('change', event => handleToggle('claude', event));
document.getElementById('toggle_chatgpt').addEventListener('change', event => handleToggle('chatgpt', event));
document.getElementById('toggle_gemini').addEventListener('change', event => handleToggle('gemini', event));

// New values arrive through storage.onChanged; the button only shows the wait.
const refreshButton = document.getElementById('refresh');
refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = msg('checking');
  try { await chrome.runtime.sendMessage({type:'REFRESH_ALL'}); }
  catch (_) {}
  refreshButton.disabled = false;
  refreshButton.textContent = REFRESH_TEXT;
});
document.getElementById('openClaude').addEventListener('click',()=>chrome.runtime.sendMessage({type:'OPEN_CLAUDE_USAGE'}));
document.getElementById('openChatGPT').addEventListener('click',()=>chrome.runtime.sendMessage({type:'OPEN_CHATGPT_USAGE'}));
document.getElementById('openGemini').addEventListener('click',()=>chrome.runtime.sendMessage({type:'OPEN_GEMINI_USAGE'}));

// The hint names the Gemini usage page; that address becomes a link doing what
// the "Gemini usage" button does (an open usage tab first, read once loaded).
// Built from text nodes: the message stays text, no HTML in the catalog.
const GEMINI_USAGE_TEXT = 'gemini.google.com/usage';
function linkGeminiUsage(el) {
  const text = el?.textContent || '';
  const at = text.indexOf(GEMINI_USAGE_TEXT);
  if (at < 0) return;
  const link = document.createElement('a');
  link.href = 'https://gemini.google.com/usage';
  link.textContent = GEMINI_USAGE_TEXT;
  link.addEventListener('click', event => {
    event.preventDefault();
    chrome.runtime.sendMessage({type:'OPEN_GEMINI_USAGE'});
  });
  el.replaceChildren(text.slice(0, at), link, text.slice(at + GEMINI_USAGE_TEXT.length));
}

// Open the floating overlay: background opens the Leeway window (or brings the
// open one forward), and the always-on-top overlay opens from there — the same
// on any tab, the Web Store and chrome:// pages included (CLAUDE.md §4).
document.getElementById('openOverlay').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({type:'OPEN_OVERLAY_WINDOW'}); }
  catch (_) {}
  try { window.close(); } catch (_) {}
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some(key => key === 'enabledProviders' || key.startsWith('usage_') || key.startsWith('peer_'))) render();
});

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
linkGeminiUsage(document.querySelector('[data-i18n="note_main"]'));
// "3분 전", staleness and the reset countdowns move with the clock, not only with storage.
setInterval(render, 30 * 1000);
render();
