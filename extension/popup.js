import { usageKey, lastOkKey } from './snapshot.js';
import { providerView } from './view.js';
import { viewLabels, msg } from './i18n.js';

const PROVIDER_HOSTS = {claude:'https://claude.ai/*', chatgpt:'https://chatgpt.com/*', gemini:'https://gemini.google.com/*'};
const POPUP_PROVIDERS = Object.keys(PROVIDER_HOSTS);
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

// Storage changes, the clock tick and toggles can overlap; only the newest
// render writes to the page.
let renders = 0;
async function render() {
  const current = ++renders;
  const keys = ['enabledProviders', ...POPUP_PROVIDERS.flatMap(p => [usageKey(p), lastOkKey(p)])];
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

// Open the floating overlay: inject overlay_inject.js into the active tab (it
// opens a Picture-in-Picture window). Needs a normal web page as the opener.
document.getElementById('openOverlay').addEventListener('click', async () => {
  const ovmsg = document.getElementById('ovmsg');
  ovmsg.textContent = '';
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab || !/^https?:\/\//.test(tab.url || '')) { ovmsg.textContent = msg('overlay_hint'); return; }
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['overlay_inject.js']});
    try { window.close(); } catch (_) {}
  } catch (_) {
    ovmsg.textContent = msg('overlay_hint');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some(key => key === 'enabledProviders' || key.startsWith('usage_'))) render();
});

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
// "3분 전", staleness and the reset countdowns move with the clock, not only with storage.
setInterval(render, 30 * 1000);
render();
