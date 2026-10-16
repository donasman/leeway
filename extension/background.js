import { clampPct, fmtReset, pickClaudeBuckets } from './parsers.js';
import { snapshotWrites, usageKey, lastOkKey } from './snapshot.js';
import { whamPayload, whamPlan, whamWindows } from './chatgpt_api.js';
import { geminiPayload } from './gemini.js';
import { badgeView, providerView } from './view.js';
import { viewLabels } from './i18n.js';

const ENDPOINT = 'http://127.0.0.1:8765/usage';
const HEALTH = 'http://127.0.0.1:8765/health';
const BRIDGE_ORIGIN = 'http://127.0.0.1:8765/*';
const ALARM = 'llm-usage-refresh';
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
const CHATGPT_SESSION_URL = 'https://chatgpt.com/api/auth/session';
const CHATGPT_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const POLL_MINUTES = 2;
const BRIDGE_TIMEOUT_MS = 5000;
const GEMINI_USAGE_URL = 'https://gemini.google.com/usage';
const PROVIDER_HOSTS = {claude:'https://claude.ai/*', chatgpt:'https://chatgpt.com/*', gemini:'https://gemini.google.com/*'};

async function getEnabledProviders() {
  const stored = await chrome.storage.local.get(['enabledProviders']);
  return new Set(stored.enabledProviders || []);
}

async function hasHostPermission(provider) {
  const host = PROVIDER_HOSTS[provider];
  if (!host) return false;
  try { return await chrome.permissions.contains({origins:[host]}); }
  catch (_) { return false; }
}

// The desktop bridge host is an optional permission (not requested until the
// Phase 2 desktop app asks for it), so there is no install-time 127.0.0.1
// warning. Until it is granted every bridge call no-ops and the overlay reads
// as off.
async function bridgeAllowed() {
  try { return await chrome.permissions.contains({origins:[BRIDGE_ORIGIN]}); }
  catch (_) { return false; }
}

// enabledProviders is written only here. The popup asks with PROVIDER_ENABLED /
// PROVIDER_DISABLED. Turning on also follows permissions.onAdded: Chrome may
// close the popup while it shows the permission prompt, and the rest of the
// popup's toggle handler goes with it.
// Turning on and off run one at a time, start to finish: an enable that
// arrives while a turn-off is still removing the permission waits for it, and
// then finds the permission gone.
let providerChanges = Promise.resolve();
function oneAtATime(task) {
  const run = providerChanges.then(task);
  providerChanges = run.catch(() => {});
  return run;
}

async function setEnabled(provider, on) {
  const enabled = await getEnabledProviders();
  if (enabled.has(provider) === on) return false;
  if (on) enabled.add(provider);
  else enabled.delete(provider);
  await chrome.storage.local.set({enabledProviders: [...enabled]});
  return true;
}

// true when this call turned it on (so the caller refreshes once).
function enableProvider(provider) {
  return oneAtATime(async () => (await hasHostPermission(provider)) && setEnabled(provider, true));
}

// Out of enabledProviders first: a refresh still in flight for this provider
// is then dropped by publish() instead of landing after 'disabled'. The site
// permission goes last; onRemoved skips providers that are already off.
function disableProvider(provider) {
  return oneAtATime(async () => {
    await setEnabled(provider, false);
    if (provider === 'chatgpt') await chrome.storage.local.remove('chatgpt_debug');
    await publish({provider, value:'?', detail:'disabled by user', status:'disabled', limits:[]});
    const host = PROVIDER_HOSTS[provider];
    if (host) {
      try { await chrome.permissions.remove({origins:[host]}); }
      catch (_) {}
    }
  });
}

async function pairIfNeeded() {
  if (!await bridgeAllowed()) return;
  try {
    const r = await fetch('http://127.0.0.1:8765/pair', {cache: 'no-store'});
    if (r.ok) {
      const data = await r.json();
      if (data.token) await chrome.storage.local.set({bridge_token: data.token});
    }
  } catch (_) {}
}

// Every collector result goes through here: save first, then try the desktop
// bridge. The bridge is optional (CLAUDE.md §2) — absent or failing, it never
// touches the usage_* keys. Results for providers the user hasn't enabled are
// dropped, e.g. from a chatgpt.js still running in a tab after ChatGPT was
// turned off, or a refresh that lands after it was turned off
// (disableProvider() takes it out of enabledProviders before this).
// 'disabled' is let through: it is the turning-off itself.
async function publish(payload) {
  try {
    if (payload?.status !== 'disabled') {
      const enabled = await getEnabledProviders();
      if (!enabled.has(String(payload?.provider || '').toLowerCase())) {
        return {ok: false, at: Date.now(), error: 'provider-not-enabled', status: payload?.status};
      }
    }
    const writes = snapshotWrites(payload, Date.now());
    if (writes) await chrome.storage.local.set(writes);
  } catch (error) {
    console.warn('usage snapshot not saved:', String(error));
  }
  return sendToBridge(payload);
}

// Bridge send only. The result goes back to the caller and is not stored. The
// payload shape is what the desktop builds expect — keep it. The timeout keeps
// a hung desktop app from holding up publish() — turning off waits for it.
async function sendToBridge(payload) {
  if (!await bridgeAllowed()) return {ok: false, at: Date.now(), error: 'no-bridge-permission', status: payload.status || 'parse_failed'};
  try {
    const stored = await chrome.storage.local.get('bridge_token');
    const token = stored.bridge_token || '';
    const response = await fetch(ENDPOINT, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Bridge-Token': token}, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {ok: true, at: Date.now(), value: payload.value, detail: payload.detail || '', status: payload.status};
  } catch (error) {
    return {ok: false, at: Date.now(), error: String(error), status: payload.status || 'parse_failed'};
  }
}

async function checkHealth() {
  if (!await bridgeAllowed()) return {ok: false, error: 'no-permission'};
  try { const r = await fetch(HEALTH, {cache:'no-store'}); return {ok:r.ok,status:r.status}; }
  catch (error) { return {ok:false,error:String(error)}; }
}

// What the floating overlay (overlay_inject.js) renders: one providerView per
// provider, built the same way the popup builds it, so the two always match.
async function overlayData() {
  const labels = viewLabels();
  const enabled = await getEnabledProviders();
  const now = Date.now();
  const providers = [];
  for (const provider of Object.keys(PROVIDER_HOSTS)) {
    const on = enabled.has(provider);
    const permitted = on && await hasHostPermission(provider);
    const stored = await chrome.storage.local.get([usageKey(provider), lastOkKey(provider)]);
    const view = providerView({enabled: on, permitted, latest: stored[usageKey(provider)], lastOk: stored[lastOkKey(provider)]}, now, undefined, labels);
    providers.push({provider, enabled: on, state: view.state, status: view.status, rows: view.rows, dim: view.dim, note: view.note});
  }
  return {providers, now};
}

async function fetchClaudeJson(url) {
  const r = await fetch(url, {credentials:'include', headers:{Accept:'application/json, text/plain, */*'}});
  if (r.status === 401 || r.status === 403) throw new Error(`auth-${r.status}`);
  if (!r.ok) throw new Error(`http-${r.status}`);
  return r.json();
}
async function getClaudeOrgId() {
  const payload = await fetchClaudeJson('https://claude.ai/api/organizations');
  const orgs = Array.isArray(payload) ? payload : (Array.isArray(payload?.organizations) ? payload.organizations : []);
  const org = orgs.find(o => Array.isArray(o?.capabilities) && o.capabilities.includes('chat')) || orgs[0];
  return org && (org.uuid || org.organization_uuid || org.id);
}
async function refreshClaude() {
  try {
    const orgId = await getClaudeOrgId();
    if (!orgId) throw new Error('org-not-found');
    const usage = await fetchClaudeJson(`https://claude.ai/api/organizations/${orgId}/usage`);
    const {session, weekly} = pickClaudeBuckets(usage);
    const sessionUsed = clampPct(session?.utilization);
    const weeklyUsed = clampPct(weekly?.utilization);
    if (sessionUsed === null && weeklyUsed === null) throw new Error('usage-data-not-found');
    const remaining = sessionUsed === null ? null : Math.round(100 - sessionUsed);
    const value = remaining === null ? '?' : `${remaining}%`;
    const details = [];
    if (sessionUsed !== null) details.push(`5-hour limit: ${Math.round(100 - sessionUsed)}% remaining`);
    if (session?.resets_at) details.push(`resets ${fmtReset(session.resets_at)}`);
    if (weeklyUsed !== null) details.push(`weekly limit: ${Math.round(100 - weeklyUsed)}% remaining`);
    // Normalized fields — additive. `value`/`detail` above are unchanged so
    // the Python overlay on the main branch keeps rendering the same string.
    // The 5-hour entry is always listed, null when unreadable (CLAUDE.md §1, §2):
    // leaving it out would read as "this account has no 5-hour limit" and
    // promote the weekly value. No Claude plan is known to lack one.
    const limits = [{
      id: 'claude_5h', label: '5-hour limit',
      remaining_percent: sessionUsed === null ? null : Math.round(100 - sessionUsed),
      resets_at: session?.resets_at || null,
      reset_text: session?.resets_at ? `resets ${fmtReset(session.resets_at)}` : null,
    }];
    if (weeklyUsed !== null) limits.push({
      id: 'claude_weekly', label: 'Weekly limit',
      remaining_percent: Math.round(100 - weeklyUsed),
      resets_at: weekly?.resets_at || null,
      reset_text: weekly?.resets_at ? `resets ${fmtReset(weekly.resets_at)}` : null,
    });
    const payload = {provider:'claude', value, detail:details.join(' · ') || 'Claude usage available', status:'ok', limits};
    return await publish(payload);
  } catch (error) {
    const msg = String(error.message || error);
    const status = (msg === 'auth-401' || msg === 'auth-403') ? 'logged_out' : 'parse_failed';
    return await publish({provider:'claude', value:'?', detail:`Claude usage unavailable: ${msg}`, status, limits:[]});
  }
}

/// ---- ChatGPT ---------------------------------------------------------------

const chatgptFailure = (status, step) => Object.assign(new Error(step), {usageStatus: status});
// A request that throws: only the error's name goes on. Its message could, in
// some runtime, quote a header — and the usage request carries the token.
const requestFailed = (step, error) => chatgptFailure('parse_failed', `${step}: request failed (${error?.name || 'Error'})`);
const notJson = response => `not JSON (${(response.headers.get('content-type') || 'no content type').split(';')[0]})`;
// URLs in error texts keep only their origin (tab URLs can carry a conversation id).
const originsOnly = text => String(text).replace(/(https?:\/\/[^\s/?#"']+)[^\s"']*/g, '$1');

async function jsonOrNull(response) {
  try { return JSON.parse(await response.text()); }
  catch (_) { return null; }
}

// The endpoint ChatGPT's own Settings > Usage page reads (unofficial,
// CLAUDE.md §2), like refreshClaude(): no tab needed. The access token exists
// only in this function's variables — never stored, logged, put in the
// diagnostics or sent to the bridge (CLAUDE.md §3). Of the session only
// accessToken and account.id are read.
async function fetchChatGPTUsage(debug) {
  let sessionResponse;
  try { sessionResponse = await fetch(CHATGPT_SESSION_URL, {credentials:'include', cache:'no-store', headers:{Accept:'application/json'}}); }
  catch (error) { throw requestFailed('session', error); }
  debug.sessionStatus = sessionResponse.status;
  const session = await jsonOrNull(sessionResponse);
  // Signed out is a 200 without a token. A 401/403 here comes from in front of
  // the site (e.g. a Cloudflare check), not from the session: the page fallback
  // may still work.
  if (!sessionResponse.ok) throw chatgptFailure('parse_failed', `session: HTTP ${sessionResponse.status}${session ? '' : `, ${notJson(sessionResponse)}`}`);
  if (!session) throw chatgptFailure('parse_failed', `session: ${notJson(sessionResponse)}`);
  const token = typeof session.accessToken === 'string' ? session.accessToken : '';
  debug.token = Boolean(token);
  if (!token) throw chatgptFailure('logged_out', 'session: no access token (signed out?)');
  const headers = {Accept:'application/json', Authorization:`Bearer ${token}`};
  const accountId = session.account?.id;
  if (typeof accountId === 'string' && accountId) headers['chatgpt-account-id'] = accountId;

  let response;
  // redirect:'error': the token goes to this URL and nowhere else.
  try { response = await fetch(CHATGPT_USAGE_API_URL, {credentials:'include', cache:'no-store', redirect:'error', headers}); }
  catch (error) { throw requestFailed('usage', error); }
  debug.usageStatus = response.status;
  debug.contentType = (response.headers.get('content-type') || '').split(';')[0];
  const body = await jsonOrNull(response);
  // Only a JSON 401 is the API refusing the session. A 403 can be other checks
  // (e.g. unusual activity), and HTML is not the API at all.
  if (response.status === 401 && body) throw chatgptFailure('logged_out', 'usage: HTTP 401');
  if (!response.ok || !body) throw chatgptFailure('parse_failed', `usage: HTTP ${response.status}${body ? '' : `, ${notJson(response)}`}`);
  return body;
}

// Settings > Usage only: the page (/settings/usage) or the dialog over the
// home page (/#settings/Usage) — not a conversation with that dialog open
// (/c/<id>#settings/Usage).
function isUsageUrl(url = '') {
  try {
    const {pathname, hash} = new URL(url);
    return /^\/settings\/usage\/?$/i.test(pathname) || (pathname === '/' && /^#settings\/usage$/i.test(hash));
  } catch (_) { return false; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TAB_TIMEOUT_MS = 5000;
function withTimeout(promise, ms, message) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
async function scanTab(tab, attempts = 1) {
  // Static content_scripts registration was removed (optional host permissions),
  // so the first sendMessage will always fail until chatgpt.js is injected via
  // executeScript. Force at least one retry so injection + rescan can happen.
  const effectiveAttempts = Math.max(attempts, 2);
  let lastError = null;
  let injectError = '';
  for (let attempt = 0; attempt < effectiveAttempts; attempt += 1) {
    try {
      const response = await withTimeout(chrome.tabs.sendMessage(tab.id, {type:'SCAN_USAGE'}), TAB_TIMEOUT_MS, 'no answer in time');
      if (response?.payload) return response;
      lastError = new Error('no-scan-response');
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        try {
          await withTimeout(chrome.scripting.executeScript({target:{tabId:tab.id}, files:['chatgpt.js']}), TAB_TIMEOUT_MS, 'injection timed out');
        } catch (failure) { injectError = String(failure.message || failure); }
      }
    }
    if (attempt + 1 < effectiveAttempts) await delay(1200 + attempt * 1200);
  }
  const message = String(lastError?.message || lastError || 'no-scan-response');
  throw new Error(injectError ? `${message} (inject: ${injectError})` : message);
}

// What a usage tab's scan says about where it failed — and no page text: the
// usage page can show the conversation list beside it (CLAUDE.md §1, §3).
function pageDiagnostics(d) {
  let url = '';
  try { const {origin, pathname} = new URL(d?.url); url = origin + pathname; }
  catch (_) {}
  const percentages = Array.isArray(d?.percentages) ? d.percentages : [];
  return {
    url,
    routeDetected: Boolean(d?.routeDetected),
    fiveHourLabelFound: Boolean(d?.fiveHourLabelFound),
    weeklyLabelFound: Boolean(d?.weeklyLabelFound),
    percentages: percentages.filter(p => typeof p === 'string' && /^\d{1,3}(?:[.,]\d+)?\s*%\s*(?:remaining|left|남음|잔여)$/i.test(p)).slice(0, 8),
    selected: typeof d?.selected === 'string' && /^(?:\?|\d{1,3}%)$/.test(d.selected) ? d.selected : '?',
    failedStep: typeof d?.failedStep === 'string' ? d.failedStep.slice(0, 120) : '',
  };
}

// Fallback when the API gives no primary value: a Settings > Usage tab the
// user already has open. No tab is opened for it, and conversation tabs are
// never injected into (CLAUDE.md §3).
async function scanOpenUsageTab(debug) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({url:'https://chatgpt.com/*'}); }
  catch (_) {}
  // Discarded and frozen (Chrome 132+) tabs can't answer.
  const usageTabs = tabs.filter(tab => isUsageUrl(tab.url) && !tab.discarded && !tab.frozen);
  debug.dom = {usageTabs: usageTabs.length};
  for (const tab of usageTabs) {
    try {
      const response = await scanTab(tab, 3);
      debug.dom = {usageTabs: usageTabs.length, ...pageDiagnostics(response.debug)};
      if (response.payload?.status === 'ok') return response.payload;
    } catch (error) {
      debug.dom = {usageTabs: usageTabs.length, failedStep: `Could not inspect the usage tab: ${originsOnly(error.message || error)}`};
    }
  }
  return null;
}

async function refreshChatGPT() {
  // Off, or its permission gone — whether since this was asked for (the
  // diagnostics button) or while it ran: leave chatgpt.com alone.
  const stillOn = async () => (await getEnabledProviders()).has('chatgpt') && hasHostPermission('chatgpt');
  if (!(await stillOn())) return {ok:false, error:'provider-not-enabled'};
  const debug = {at:Date.now(), source:'api'};
  let payload = null;
  let failure = null;
  try {
    const body = await fetchChatGPTUsage(debug);
    debug.plan = whamPlan(body);
    debug.windows = whamWindows(body);
    payload = whamPayload(body, Date.now());
  } catch (error) {
    debug.failedStep = String(error.message || error);
    failure = {provider:'chatgpt', value:'?', detail:`ChatGPT usage unavailable: ${debug.failedStep}`, status:error.usageStatus || 'parse_failed', limits:[]};
  }
  if (payload && payload.status !== 'ok') {
    debug.failedStep = payload.detail;
    failure = payload; // keeps what the API could read, for display
    payload = null;
  }
  // No primary value from the API: an open Settings > Usage tab may have it.
  // Not when signed out.
  if (!payload && failure.status !== 'logged_out' && await stillOn()) payload = await scanOpenUsageTab(debug);
  if (!debug.failedStep) debug.failedStep = 'none';
  if (await stillOn()) await chrome.storage.local.set({chatgpt_debug:debug});
  return publish(payload || failure);
}

// ---- Gemini ----------------------------------------------------------------
// No usage API: read from an already-open gemini.google.com/usage tab only
// (CLAUDE.md §2 Gemini). The page's numbers are drawn client-side and its class
// names are hashed, so gemini_scan.js reads the rendered DOM by label text.
const GEMINI_SCAN_TIMEOUT_MS = 12000; // gemini_scan.js waits up to 10s for a late render

// The usage screen only — gemini.google.com/usage — not a chat tab.
function isGeminiUsageUrl(url = '') {
  try {
    const {hostname, pathname} = new URL(url);
    return hostname === 'gemini.google.com' && /^\/usage\/?$/i.test(pathname);
  } catch (_) { return false; }
}

// Inject gemini_scan.js and ask it to read the cards. Same shape as scanTab():
// the first sendMessage fails until the script is injected (optional host
// permissions, no static content_scripts), so force at least one retry.
async function scanGeminiTab(tab, attempts = 2) {
  const effectiveAttempts = Math.max(attempts, 2);
  let lastError = null;
  let injectError = '';
  for (let attempt = 0; attempt < effectiveAttempts; attempt += 1) {
    try {
      const response = await withTimeout(chrome.tabs.sendMessage(tab.id, {type:'SCAN_GEMINI'}), GEMINI_SCAN_TIMEOUT_MS, 'no answer in time');
      if (response?.cards) return response;
      lastError = new Error('no-scan-response');
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        try { await withTimeout(chrome.scripting.executeScript({target:{tabId:tab.id}, files:['gemini_scan.js']}), TAB_TIMEOUT_MS, 'injection timed out'); }
        catch (failure) { injectError = String(failure.message || failure); }
      }
    }
    if (attempt + 1 < effectiveAttempts) await delay(1200 + attempt * 1200);
  }
  const message = String(lastError?.message || lastError || 'no-scan-response');
  throw new Error(injectError ? `${message} (inject: ${injectError})` : message);
}

// The scanned card text from an open usage tab, or null when none answered. No
// tab is opened, and chat tabs are never injected into (CLAUDE.md §3). A tab
// with a readable current card wins; otherwise the first tab that answered (so
// a genuinely empty/signed-out page still becomes a parse_failed, not "no tab").
async function scanGeminiUsageTab() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({url:'https://gemini.google.com/*'}); }
  catch (_) {}
  const usageTabs = tabs.filter(tab => isGeminiUsageUrl(tab.url) && !tab.discarded && !tab.frozen);
  let fallback = null;
  for (const tab of usageTabs) {
    let response;
    try { response = await scanGeminiTab(tab); }
    catch (_) { continue; }
    if (response.cards?.current?.used) return response.cards;
    if (!fallback) fallback = response.cards;
  }
  return fallback;
}

async function refreshGemini() {
  // Off, or its permission gone — whether since this was asked for or while it ran.
  const stillOn = async () => (await getEnabledProviders()).has('gemini') && hasHostPermission('gemini');
  if (!(await stillOn())) return {ok:false, error:'provider-not-enabled'};
  let payload;
  try {
    const cards = await scanGeminiUsageTab();
    payload = cards
      ? geminiPayload(cards, Date.now())
      : {provider:'gemini', value:'?', detail:'No open Gemini usage tab (open gemini.google.com/usage)', status:'parse_failed', limits:[]};
  } catch (error) {
    payload = {provider:'gemini', value:'?', detail:`Gemini usage unavailable: ${originsOnly(error.message || error)}`, status:'parse_failed', limits:[]};
  }
  return publish(payload);
}

// ---- toolbar badge (CLAUDE.md §4) ------------------------------------------

const PROVIDER_NAMES = {claude:'Claude', chatgpt:'ChatGPT', gemini:'Gemini'};
// Overlapping updates (several results saved at once) read storage at
// different moments; only the newest one sets the badge.
let badgeUpdates = 0;
async function updateBadge() {
  const current = ++badgeUpdates;
  try {
    const providers = Object.keys(PROVIDER_HOSTS);
    const data = await chrome.storage.local.get(['enabledProviders', ...providers.flatMap(p => [usageKey(p), lastOkKey(p)])]);
    const enabled = new Set(Array.isArray(data.enabledProviders) ? data.enabledProviders : []);
    const entries = await Promise.all(providers.map(async p => ({
      name: PROVIDER_NAMES[p] || p,
      enabled: enabled.has(p),
      permitted: enabled.has(p) && await hasHostPermission(p),
      latest: data[usageKey(p)],
      lastOk: data[lastOkKey(p)],
    })));
    if (current !== badgeUpdates) return;
    const badge = badgeView(entries, Date.now(), undefined, viewLabels());
    await chrome.action.setBadgeText({text: badge.text});
    await chrome.action.setBadgeBackgroundColor({color: badge.color});
    await chrome.action.setTitle({title: badge.title});
  } catch (error) {
    console.warn('badge not updated:', String(error));
  }
}

async function refreshAll() {
  const enabled = await getEnabledProviders();
  const tasks = [];
  if (enabled.has('claude')) {
    tasks.push((await hasHostPermission('claude'))
      ? refreshClaude()
      : publish({provider:'claude', value:'?', detail:'Grant claude.ai permission in extension popup', status:'needs_permission', limits:[]}));
  }
  if (enabled.has('chatgpt')) {
    tasks.push((await hasHostPermission('chatgpt'))
      ? refreshChatGPT()
      : publish({provider:'chatgpt', value:'?', detail:'Grant chatgpt.com permission in extension popup', status:'needs_permission', limits:[]}));
  }
  if (enabled.has('gemini')) {
    tasks.push((await hasHostPermission('gemini'))
      ? refreshGemini()
      : publish({provider:'gemini', value:'?', detail:'Grant gemini.google.com permission in extension popup', status:'needs_permission', limits:[]}));
  }
  await Promise.allSettled(tasks);
}
function setupAlarm() {
  chrome.alarms.create(ALARM, {periodInMinutes:POLL_MINUTES});
}
// Removed on install and update (2026-10-15). Keys nothing reads any more:
// bridge send results the popup used to show before it read usage_*, and the
// ChatGPT tab id the extension used to open for reading. And chatgpt_debug:
// before the API switch it could hold conversation text; the next read
// writes it again.
const LEGACY_KEYS = ['last_claude', 'last_chatgpt', 'chatgptUsageTabId', 'chatgpt_debug'];
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(LEGACY_KEYS).catch(() => {});
  pairIfNeeded(); setupAlarm(); setTimeout(refreshAll, 1000);
});
chrome.runtime.onStartup.addListener(() => { pairIfNeeded(); setupAlarm(); setTimeout(refreshAll, 1000); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) refreshAll(); });

// The badge follows what is stored: every saved result (publish()) and every
// turn on/off changes one of these keys. Also set once whenever the service
// worker starts, so it is right before the first refresh.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some(key => key === 'enabledProviders' || key.startsWith('usage_'))) updateBadge();
});
updateBadge();

// Only the extension's own pages talk to background. Content scripts don't
// report by themselves (background asks chatgpt.js with SCAN_USAGE), so a
// message from a web page is ignored. sender.url is the page that sent it.
const EXTENSION_ORIGIN = chrome.runtime.getURL('');
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Extension pages (the popup) may send anything. Our injected overlay content
  // script runs in the host page, so its sender.url is that page — allow it the
  // read-only OVERLAY_DATA (sender.id proves it is ours); everything that
  // changes state stays restricted to the extension's own pages.
  const fromPage = String(sender?.url || '').startsWith(EXTENSION_ORIGIN);
  if (!fromPage && !(message?.type === 'OVERLAY_DATA' && sender?.id === chrome.runtime.id)) return;
  if (message?.type === 'usage') { publish(message.payload).then(sendResponse); return true; }
  if (message?.type === 'health') { checkHealth().then(sendResponse); return true; }
  if (message?.type === 'OVERLAY_DATA') { overlayData().then(sendResponse); return true; }
  if (message?.type === 'REFRESH_ALL') { refreshAll().then(() => sendResponse({ok:true})); return true; }
  if (message?.type === 'PROVIDER_ENABLED') {
    // Answer once it is on; the refresh needn't hold up the popup's toggle.
    enableProvider(message.provider).catch(() => false)
      .then(turnedOn => { sendResponse({ok:true}); if (turnedOn) refreshAll(); });
    return true;
  }
  if (message?.type === 'PROVIDER_DISABLED') {
    disableProvider(message.provider).catch(() => {}).then(() => sendResponse({ok:true}));
    return true;
  }
  if (message?.type === 'OPEN_CLAUDE_USAGE') { chrome.tabs.create({url:'https://claude.ai/settings/usage',active:true}); sendResponse({ok:true}); }
  if (message?.type === 'OPEN_CHATGPT_USAGE') { chrome.tabs.create({url:CHATGPT_USAGE_URL,active:true}); sendResponse({ok:true}); }
  if (message?.type === 'OPEN_GEMINI_USAGE') { chrome.tabs.create({url:GEMINI_USAGE_URL,active:true}); sendResponse({ok:true}); }
});

// Granted from the popup's toggle (or anywhere else): turn the provider on,
// whether or not the popup is still open to ask.
chrome.permissions.onAdded.addListener(async permissions => {
  const addedOrigins = permissions?.origins || [];
  let turnedOn = false;
  for (const [provider, host] of Object.entries(PROVIDER_HOSTS)) {
    if (addedOrigins.includes(host) && await enableProvider(provider)) turnedOn = true;
  }
  if (turnedOn) await refreshAll();
});

chrome.permissions.onRemoved.addListener(async permissions => {
  const removedOrigins = permissions?.origins || [];
  if (!removedOrigins.length) return;
  const enabled = await getEnabledProviders();
  for (const [provider, host] of Object.entries(PROVIDER_HOSTS)) {
    if (!removedOrigins.includes(host)) continue;
    if (!enabled.has(provider)) continue;
    await publish({provider, value:'?', detail:'Host permission revoked', status:'needs_permission', limits:[]});
  }
});
