import { clampPct, claudePlanLabel, fmtReset, pickClaudeBuckets } from './parsers.js';
import { snapshotWrites, usageKey, lastOkKey } from './snapshot.js';
import { whamPayload, whamPlan, whamWindows } from './chatgpt_api.js';
import { geminiPayload } from './gemini.js';
import { badgeView } from './view.js';
import { HELPER_HOST, PEER_PERMISSION, cleanLabel, newProfileId, peerRecord, sharedSnapshots } from './peers.js';
import { viewLabels } from './i18n.js';

const ALARM = 'llm-usage-refresh';
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
const CHATGPT_SESSION_URL = 'https://chatgpt.com/api/auth/session';
const CHATGPT_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const POLL_MINUTES = 2;
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

// Every collector result goes through here and is saved. Results for
// providers the user hasn't enabled are dropped, e.g. from a chatgpt.js still
// running in a tab after ChatGPT was
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
    return {ok: false, at: Date.now(), error: 'not-saved', status: payload?.status};
  }
  return {ok: true, at: Date.now(), status: payload?.status};
}

async function fetchClaudeJson(url) {
  const r = await fetch(url, {credentials:'include', headers:{Accept:'application/json, text/plain, */*'}});
  if (r.status === 401 || r.status === 403) throw new Error(`auth-${r.status}`);
  if (!r.ok) throw new Error(`http-${r.status}`);
  return r.json();
}
// One claude.ai sign-in can belong to several organizations: a personal plan,
// a Team workspace, an API-only one. Chat organizations are the ones with
// usage limits; the first is the main one (the toolbar badge and the big
// number), the others are listed under it. Of each organization only its id
// (for the usage URL), capabilities and rate_limit_tier (for the plan label)
// are read; its name is not, as a personal one carries the email address.
const MAX_CLAUDE_ORGS = 4;
async function getClaudeOrgs() {
  const payload = await fetchClaudeJson('https://claude.ai/api/organizations');
  const orgs = Array.isArray(payload) ? payload : (Array.isArray(payload?.organizations) ? payload.organizations : []);
  const chat = orgs.filter(o => Array.isArray(o?.capabilities) && o.capabilities.includes('chat'));
  return (chat.length ? chat : orgs.slice(0, 1))
    .map(org => ({id: org && (org.uuid || org.organization_uuid || org.id), plan: claudePlanLabel(org)}))
    .filter(org => org.id)
    .slice(0, MAX_CLAUDE_ORGS);
}

// The 5-hour entry is always listed, null when unreadable (CLAUDE.md §1, §2):
// leaving it out would read as "this account has no 5-hour limit" and promote
// the weekly value. No Claude plan is known to lack one.
function claudeLimits(usage) {
  const {session, weekly} = pickClaudeBuckets(usage);
  const sessionUsed = clampPct(session?.utilization);
  const weeklyUsed = clampPct(weekly?.utilization);
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
  return {limits, session, sessionUsed, weeklyUsed};
}

const claudeFailureStatus = msg => ((msg === 'auth-401' || msg === 'auth-403') ? 'logged_out' : 'parse_failed');

// Another organization's read. Its failure stays its own: the main one and
// the others still show.
async function readClaudeAccount(org) {
  try {
    const usage = await fetchClaudeJson(`https://claude.ai/api/organizations/${org.id}/usage`);
    const {limits, sessionUsed, weeklyUsed} = claudeLimits(usage);
    const status = sessionUsed === null && weeklyUsed === null ? 'parse_failed' : 'ok';
    return {plan: org.plan, status, limits};
  } catch (error) {
    return {plan: org.plan, status: claudeFailureStatus(String(error.message || error)), limits: []};
  }
}

async function refreshClaude() {
  try {
    const orgs = await getClaudeOrgs();
    if (!orgs.length) throw new Error('org-not-found');
    const [main, ...others] = orgs;
    const usage = await fetchClaudeJson(`https://claude.ai/api/organizations/${main.id}/usage`);
    const {limits, session, sessionUsed, weeklyUsed} = claudeLimits(usage);
    if (sessionUsed === null && weeklyUsed === null) throw new Error('usage-data-not-found');
    const remaining = sessionUsed === null ? null : Math.round(100 - sessionUsed);
    const value = remaining === null ? '?' : `${remaining}%`;
    const details = [];
    if (sessionUsed !== null) details.push(`5-hour limit: ${Math.round(100 - sessionUsed)}% remaining`);
    if (session?.resets_at) details.push(`resets ${fmtReset(session.resets_at)}`);
    if (weeklyUsed !== null) details.push(`weekly limit: ${Math.round(100 - weeklyUsed)}% remaining`);
    const payload = {provider:'claude', value, detail:details.join(' · ') || 'Claude usage available', status:'ok', limits, plan: main.plan};
    if (others.length) {
      const rest = [];
      for (const org of others) rest.push(await readClaudeAccount(org));
      payload.accounts = [{plan: main.plan, status: 'ok', limits}, ...rest];
    }
    return await publish(payload);
  } catch (error) {
    const msg = String(error.message || error);
    return await publish({provider:'claude', value:'?', detail:`Claude usage unavailable: ${msg}`, status: claudeFailureStatus(msg), limits:[]});
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
// diagnostics (CLAUDE.md §3). Of the session only
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
// tab is opened here: it reads only usage tabs the user opened (by hand or with
// the popup's button, openGeminiUsage()), and chat tabs are never injected
// into (CLAUDE.md §3). A tab
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

// ---- Gemini: the usage tab opened from the popup ---------------------------
// The popup's button opens gemini.google.com/usage (or brings an open one
// forward), and the popup closes with it. Background then reads the tab once
// it has loaded, so the value shows without waiting for the next 2-minute
// round (CLAUDE.md §2 Gemini). It only waits and calls refreshGemini(): the
// Gemini page itself is never reloaded.
// The wait {id, tabId, openedAt, phase} lives in storage.session so a service
// worker that went down in between picks it up from the next tab event. One
// at a time: a new press replaces it, and a timer left from the old one sees a
// different id and stops.
const GEMINI_OPEN_KEY = 'gemini_open_wait';
const GEMINI_OPEN_SETTLE_MS = 2000;         // after 'complete', before the first read
const GEMINI_OPEN_RETRY_MS = [5000, 10000]; // after a read without the current card
const GEMINI_OPEN_DEADLINE_MS = 30000;      // from opening: no new read starts after this
// A seam for tests only (tests/test_background.mjs); never set in the extension.
const openClock = () => globalThis.__leewayGeminiOpenClock || {now: () => Date.now(), wait: delay};

const geminiOn = async () => (await getEnabledProviders()).has('gemini') && hasHostPermission('gemini');

async function getOpenWait() {
  try { return (await chrome.storage.session.get(GEMINI_OPEN_KEY))[GEMINI_OPEN_KEY] || null; }
  catch (_) { return null; }
}
// Only this wait's own entry: a newer one is left alone.
async function clearOpenWait(id) {
  const wait = await getOpenWait();
  if (wait && wait.id === id) await chrome.storage.session.remove(GEMINI_OPEN_KEY).catch(() => {});
}
const isCurrentWait = async wait => (await getOpenWait())?.id === wait.id && await geminiOn();

async function startOpenWait(tabId, phase) {
  const wait = {id: crypto.randomUUID(), tabId, openedAt: openClock().now(), phase};
  await chrome.storage.session.set({[GEMINI_OPEN_KEY]: wait});
  // No 'complete' in time: one read at the deadline. A worker that went down
  // loses this timer; the next event for the tab does the same check.
  if (phase === 'waiting') openClock().wait(GEMINI_OPEN_DEADLINE_MS).then(() => readOnceIfWaiting(wait.id)).catch(() => {});
  return wait;
}

// Reads already started for a wait in this worker, so two events can't start two.
const geminiOpenReads = new Set();
async function takeWait(id) {
  const wait = await getOpenWait();
  if (!wait || wait.id !== id || wait.phase !== 'waiting' || geminiOpenReads.has(id)) return null;
  geminiOpenReads.add(id);
  const reading = {...wait, phase: 'reading'};
  await chrome.storage.session.set({[GEMINI_OPEN_KEY]: reading});
  return reading;
}

// First read after `first` ms, then GEMINI_OPEN_RETRY_MS while the current card
// is missing (logged out, still drawing). Stops on a read with it, a tab that
// closed or left the usage screen, a newer wait, Gemini turned off — or the
// deadline, which only holds back retries.
async function readOpenedGemini(wait, first) {
  const steps = [first, ...GEMINI_OPEN_RETRY_MS];
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i]) await openClock().wait(steps[i]);
    if (!await isCurrentWait(wait)) return;
    if (i > 0 && openClock().now() - wait.openedAt >= GEMINI_OPEN_DEADLINE_MS) break;
    const result = await refreshGemini();
    if (result?.status === 'ok') break;
  }
  await clearOpenWait(wait.id);
}

async function readOnceIfWaiting(id) {
  const wait = await takeWait(id);
  if (!wait) return;
  if (await geminiOn()) await refreshGemini();
  await clearOpenWait(id);
}

// Most recently used first. lastAccessed is Chrome 121+; without it the
// active tab, then the order tabs.query gave.
async function openGeminiUsageTab() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({url:'https://gemini.google.com/*'}); }
  catch (_) {}
  const usageTabs = tabs.filter(tab => isGeminiUsageUrl(tab.url));
  usageTabs.sort((a, b) => ((b.lastAccessed ?? -1) - (a.lastAccessed ?? -1)) || (Number(Boolean(b.active)) - Number(Boolean(a.active))));
  return usageTabs[0] || null;
}

async function openGeminiUsage() {
  if (await geminiOn()) {
    const tab = await openGeminiUsageTab();
    if (tab) return showGeminiUsageTab(tab);
  }
  const tab = await chrome.tabs.create({url: GEMINI_USAGE_URL, active: true});
  if (tab?.id == null || !(await geminiOn())) return;
  const wait = await startOpenWait(tab.id, 'waiting');
  // Loaded before the wait was saved: its 'complete' has gone by.
  let now = null;
  try { now = await chrome.tabs.get(tab.id); }
  catch (_) {}
  if (now?.status === 'complete' && isGeminiUsageUrl(now.url)) {
    const reading = await takeWait(wait.id);
    if (reading) await readOpenedGemini(reading, GEMINI_OPEN_SETTLE_MS);
  }
}

// An already-open usage tab: brought forward, not reopened. Discarded or still
// loading, it (re)loads now, so it waits for 'complete' like a new tab. Frozen
// (Chrome 132+), activation thaws it without a load: read after a short pause.
// Loaded, read now.
async function showGeminiUsageTab(tab) {
  const loads = Boolean(tab.discarded) || tab.status === 'unloaded' || tab.status === 'loading';
  const wait = await startOpenWait(tab.id, loads ? 'waiting' : 'reading');
  try { await chrome.tabs.update(tab.id, {active: true}); }
  catch (_) {}
  if (tab.windowId != null) {
    try { await chrome.windows.update(tab.windowId, {focused: true}); }
    catch (_) {}
  }
  if (loads) return;
  geminiOpenReads.add(wait.id);
  await readOpenedGemini(wait, tab.frozen ? GEMINI_OPEN_SETTLE_MS : 0);
}

// Every tab's updates come here (onUpdated has no URL filter in Chrome); one
// storage.session read and out unless it is the tab being waited for. The URL
// is the tab's, not changeInfo's: with the gemini.google.com permission (no
// "tabs" permission) tab.url is there on that site and missing elsewhere, so
// a tab that left for another site reads as "not the usage screen".
async function onGeminiTabUpdated(tabId, changeInfo, tab) {
  const wait = await getOpenWait();
  if (!wait || wait.tabId !== tabId) return;
  if (!isGeminiUsageUrl(tab?.url) && !isGeminiUsageUrl(tab?.pendingUrl)) return clearOpenWait(wait.id);
  if (wait.phase !== 'waiting') return;
  if (openClock().now() - wait.openedAt >= GEMINI_OPEN_DEADLINE_MS) return readOnceIfWaiting(wait.id);
  if (changeInfo?.status !== 'complete' || !isGeminiUsageUrl(tab?.url)) return;
  const reading = await takeWait(wait.id);
  if (reading) await readOpenedGemini(reading, GEMINI_OPEN_SETTLE_MS);
}

async function onGeminiTabRemoved(tabId) {
  const wait = await getOpenWait();
  if (wait?.tabId === tabId) await clearOpenWait(wait.id);
}

// ---- the Leeway window (CLAUDE.md §4) --------------------------------------
// The popup's "Open overlay" opens this small extension window, or brings the
// open one forward (restored if minimized); its own "Float on top" button
// (focused, so Enter works too) opens the PiP overlay. Nothing opens it
// without that click. Its id is kept
// in storage.session and checked with windows.get before use; when that is
// gone (a new browser session, a window Chrome restored) the window is found
// again by its page, with runtime.getContexts (Chrome 116+). It reopens where
// the user last left it (overlay_window.js saves that).
const OVERLAY_WINDOW_PAGE = 'overlay_window.html';
const OVERLAY_WINDOW_KEY = 'overlay_window_id';     // storage.session
const OVERLAY_BOUNDS_KEY = 'overlay_window_bounds'; // storage.local
const OVERLAY_WINDOW_SIZE = {width: 320, height: 480};

async function rememberOverlayWindow(id) {
  try {
    if (id == null) await chrome.storage.session.remove(OVERLAY_WINDOW_KEY);
    else await chrome.storage.session.set({[OVERLAY_WINDOW_KEY]: id});
  } catch (_) {}
}

async function findOverlayWindow() {
  let id = null;
  try { id = (await chrome.storage.session.get(OVERLAY_WINDOW_KEY))[OVERLAY_WINDOW_KEY] ?? null; }
  catch (_) {}
  if (Number.isInteger(id)) {
    try { await chrome.windows.get(id); return id; }
    catch (_) {} // closed since
  }
  // The page's URL exactly as it was opened (getContexts compares whole URLs).
  let contexts = [];
  try { contexts = await chrome.runtime.getContexts({contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL(OVERLAY_WINDOW_PAGE)]}); }
  catch (_) {} // no getContexts before Chrome 116
  const found = contexts.find(c => Number.isInteger(c.windowId) && c.windowId >= 0)?.windowId ?? null;
  if (found !== id) await rememberOverlayWindow(found);
  return found;
}

// Where it was left: four whole numbers, or null.
function savedBounds(value) {
  const keys = ['left', 'top', 'width', 'height'];
  if (!value || !keys.every(key => Number.isInteger(value[key])) || value.width <= 0 || value.height <= 0) return null;
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

async function createOverlayWindow() {
  const page = {url: chrome.runtime.getURL(OVERLAY_WINDOW_PAGE), type: 'popup', focused: true};
  let bounds = null;
  try { bounds = savedBounds((await chrome.storage.local.get(OVERLAY_BOUNDS_KEY))[OVERLAY_BOUNDS_KEY]); }
  catch (_) {}
  let win;
  try { win = await chrome.windows.create({...page, ...(bounds || OVERLAY_WINDOW_SIZE)}); }
  catch (error) {
    if (!bounds) throw error;
    // Chrome 102+ refuses a window less than half on screen (left on a
    // monitor that is gone since): the default size, placed by Chrome.
    win = await chrome.windows.create({...page, ...OVERLAY_WINDOW_SIZE});
  }
  await rememberOverlayWindow(win?.id ?? null);
}

// One at a time: a second click before the first window's page has loaded
// would not find it yet and open another.
let overlayWindowChanges = Promise.resolve();
function openOverlayWindow() {
  const run = overlayWindowChanges.then(async () => {
    const id = await findOverlayWindow();
    if (id != null) {
      try { await chrome.windows.update(id, {focused: true, state: 'normal'}); return {ok: true}; }
      catch (_) { await rememberOverlayWindow(null); } // closed in between
    }
    await createOverlayWindow();
    return {ok: true};
  });
  overlayWindowChanges = run.catch(() => {});
  return run;
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
  await syncPeers().catch(error => console.warn('peers not synced:', String(error)));
}

// ---- other Chrome profiles (Leeway helper, Native Messaging) -----------------
// Optional and off by default: the nativeMessaging permission is asked for
// only when the user turns it on in the popup. peer_settings is written only
// here; peer_profiles holds the other profiles' entries from the last round trip.

async function peersAllowed() {
  try { return await chrome.permissions.contains(PEER_PERMISSION); }
  catch (_) { return false; }
}

function askHelper(message) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendNativeMessage(HELPER_HOST, message, reply => {
        const error = chrome.runtime.lastError?.message;
        resolve(error ? {ok: false, error} : (reply || {ok: false, error: 'no answer'}));
      });
    } catch (error) {
      resolve({ok: false, error: String(error?.message || error)});
    }
  });
}

async function ownSharedSnapshots() {
  const enabled = await getEnabledProviders();
  const entries = [];
  for (const provider of Object.keys(PROVIDER_HOSTS)) {
    if (!enabled.has(provider) || !await hasHostPermission(provider)) continue;
    const stored = await chrome.storage.local.get([usageKey(provider), lastOkKey(provider)]);
    entries.push({latest: stored[usageKey(provider)], lastOk: stored[lastOkKey(provider)]});
  }
  return sharedSnapshots(entries);
}

let peerChanges = Promise.resolve();
function peersOneAtATime(task) {
  const run = peerChanges.then(task);
  peerChanges = run.catch(() => {});
  return run;
}

function syncPeers() {
  return peersOneAtATime(async () => {
    const {peer_settings: settings} = await chrome.storage.local.get('peer_settings');
    if (!settings?.on || !await peersAllowed()) return null;
    const reply = await askHelper({type: 'put', profile_id: settings.id, label: settings.label, snapshots: await ownSharedSnapshots()});
    // Turned off while the helper answered: keep nothing.
    const now = (await chrome.storage.local.get('peer_settings')).peer_settings;
    if (!now?.on) return null;
    const record = peerRecord(reply, settings.id, Date.now());
    await chrome.storage.local.set({peer_profiles: record});
    return record;
  });
}

async function enablePeers(label) {
  if (!await peersAllowed()) return {ok: false, error: 'no-permission'};
  await peersOneAtATime(async () => {
    const {peer_settings: old} = await chrome.storage.local.get('peer_settings');
    const id = typeof old?.id === 'string' && /^[a-f0-9]{16}$/.test(old.id) ? old.id : newProfileId(crypto.getRandomValues(new Uint8Array(8)));
    await chrome.storage.local.set({peer_settings: {on: true, id, label: cleanLabel(label ?? old?.label)}});
  });
  return {ok: true, record: await syncPeers()};
}

async function setPeerLabel(label) {
  await peersOneAtATime(async () => {
    const {peer_settings: settings} = await chrome.storage.local.get('peer_settings');
    if (settings?.on) await chrome.storage.local.set({peer_settings: {...settings, label: cleanLabel(label)}});
  });
  return {ok: true, record: await syncPeers()};
}

// Off: this profile's entry leaves the shared file, the other profiles'
// values are dropped here, and the permission goes back.
async function disablePeers() {
  await peersOneAtATime(async () => {
    const {peer_settings: settings} = await chrome.storage.local.get('peer_settings');
    if (settings?.on && await peersAllowed()) await askHelper({type: 'remove', profile_id: settings.id});
    await chrome.storage.local.set({peer_settings: {...(settings || {}), on: false}});
    await chrome.storage.local.remove('peer_profiles');
  });
  try { await chrome.permissions.remove(PEER_PERMISSION); }
  catch (_) {}
  return {ok: true};
}

function setupAlarm() {
  chrome.alarms.create(ALARM, {periodInMinutes:POLL_MINUTES});
}
// Removed on install and update (2026-10-15). Keys nothing reads any more:
// bridge send results the popup used to show before it read usage_*, and the
// ChatGPT tab id the extension used to open for reading. And chatgpt_debug:
// before the API switch it could hold conversation text; the next read
// writes it again. bridge_token (2026-10-27): the pairing token of the
// 127.0.0.1 desktop bridge, which is gone.
const LEGACY_KEYS = ['last_claude', 'last_chatgpt', 'chatgptUsageTabId', 'chatgpt_debug', 'bridge_token'];
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(LEGACY_KEYS).catch(() => {});
  setupAlarm(); setTimeout(refreshAll, 1000);
});
chrome.runtime.onStartup.addListener(() => { setupAlarm(); setTimeout(refreshAll, 1000); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) refreshAll(); });

// The badge follows what is stored: every saved result (publish()) and every
// turn on/off changes one of these keys. Also set once whenever the service
// worker starts, so it is right before the first refresh.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some(key => key === 'enabledProviders' || key.startsWith('usage_'))) updateBadge();
});
updateBadge();

// The Gemini usage tab opened from the popup. Registered here, at the top and
// at once, so a service worker started by a tab event still hears it; the
// wait itself is in storage.session.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  onGeminiTabUpdated(tabId, changeInfo, tab).catch(error => console.warn('gemini tab wait:', String(error)));
});
chrome.tabs.onRemoved.addListener(tabId => {
  onGeminiTabRemoved(tabId).catch(() => {});
});

// Only the extension's own pages talk to background. Content scripts don't
// report by themselves (background asks chatgpt.js with SCAN_USAGE), so a
// message from a web page is ignored. sender.url is the page that sent it.
const EXTENSION_ORIGIN = chrome.runtime.getURL('');
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The popup and the Leeway window. (The Leeway window reads its values from
  // storage itself; no web page asks for anything.)
  if (!String(sender?.url || '').startsWith(EXTENSION_ORIGIN)) return;
  if (message?.type === 'usage') { publish(message.payload).then(sendResponse); return true; }
  if (message?.type === 'REFRESH_ALL') { refreshAll().then(() => sendResponse({ok:true})); return true; }
  if (message?.type === 'PROVIDER_ENABLED') {
    // Answer once it is on; the refresh needn't hold up the popup's toggle.
    enableProvider(message.provider).catch(() => false)
      .then(turnedOn => { sendResponse({ok:true}); if (turnedOn) refreshAll(); });
    return true;
  }
  if (message?.type === 'PEERS_ENABLE') { enablePeers(message.label).then(sendResponse); return true; }
  if (message?.type === 'PEERS_DISABLE') { disablePeers().then(sendResponse); return true; }
  if (message?.type === 'PEERS_LABEL') { setPeerLabel(message.label).then(sendResponse); return true; }
  if (message?.type === 'PROVIDER_DISABLED') {
    disableProvider(message.provider).catch(() => {}).then(() => sendResponse({ok:true}));
    return true;
  }
  if (message?.type === 'OPEN_CLAUDE_USAGE') { chrome.tabs.create({url:'https://claude.ai/settings/usage',active:true}); sendResponse({ok:true}); }
  if (message?.type === 'OPEN_CHATGPT_USAGE') { chrome.tabs.create({url:CHATGPT_USAGE_URL,active:true}); sendResponse({ok:true}); }
  // The popup closes as the tab opens; the read after it runs on here.
  if (message?.type === 'OPEN_GEMINI_USAGE') { openGeminiUsage().catch(error => console.warn('gemini usage tab:', String(error))); sendResponse({ok:true}); }
  if (message?.type === 'OPEN_OVERLAY_WINDOW') {
    openOverlayWindow().then(sendResponse, error => { console.warn('Leeway window:', String(error)); sendResponse({ok:false}); });
    return true;
  }
});

// Granted from the popup's toggle (or anywhere else): turn the provider on,
// whether or not the popup is still open to ask.
chrome.permissions.onAdded.addListener(async permissions => {
  // Granted from the popup's "Other Chrome profiles" switch: turn it on even if
  // Chrome closed the popup while it asked.
  if ((permissions?.permissions || []).includes('nativeMessaging')) {
    const {peer_settings: settings} = await chrome.storage.local.get('peer_settings');
    if (!settings?.on) await enablePeers(undefined);
  }
  const addedOrigins = permissions?.origins || [];
  let turnedOn = false;
  for (const [provider, host] of Object.entries(PROVIDER_HOSTS)) {
    if (addedOrigins.includes(host) && await enableProvider(provider)) turnedOn = true;
  }
  if (turnedOn) await refreshAll();
});

chrome.permissions.onRemoved.addListener(async permissions => {
  if ((permissions?.permissions || []).includes('nativeMessaging')) {
    const {peer_settings: settings} = await chrome.storage.local.get('peer_settings');
    if (settings?.on) {
      await chrome.storage.local.set({peer_settings: {...settings, on: false}});
      await chrome.storage.local.remove('peer_profiles');
    }
  }
  const removedOrigins = permissions?.origins || [];
  if (!removedOrigins.length) return;
  const enabled = await getEnabledProviders();
  for (const [provider, host] of Object.entries(PROVIDER_HOSTS)) {
    if (!removedOrigins.includes(host)) continue;
    if (!enabled.has(provider)) continue;
    await publish({provider, value:'?', detail:'Host permission revoked', status:'needs_permission', limits:[]});
  }
});
