// Run with: node tests/test_background.mjs
//
// Loads the real extension/background.js (no copied source, CLAUDE.md §5) with
// an in-memory chrome.* stub and a fetch stub, then drives it with the same
// runtime messages the popup and chatgpt.js send. Only the paths that need no
// browser tab are covered (Claude collection, content-script results,
// enable/disable, and the Gemini usage tab the popup opens, timed with a fake
// clock) — ChatGPT tab scanning stays with test_chatgpt_parser.mjs.
//
// The claude.ai responses below are synthetic, shaped after what
// pickClaudeBuckets() reads. They are not captures of the real endpoint.

import { readFileSync } from 'node:fs';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;

function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  const tag = ok ? PASS : FAIL;
  console.log(`  [${tag}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

// ---- chrome.* stub ---------------------------------------------------------

const store = new Map();
const granted = new Set();
const handlers = {};
let writes = []; // keys of each storage.set(), in order
let tabCalls = [];
const changeListeners = [];
const badge = {text: undefined, color: undefined, title: undefined}; // what chrome.action shows
// chrome.i18n returns the Korean strings, so the badge tooltips below are unchanged (CLAUDE.md §2 다국어).
const koMessages = JSON.parse(readFileSync(new URL('../extension/_locales/ko/messages.json', import.meta.url), 'utf8'));
const KO = Object.fromEntries(Object.entries(koMessages).map(([key, value]) => [key, value.message]));

// Like Chrome: storage.onChanged comes later, for the keys a set()/remove() touched.
const announce = keys => setTimeout(() => changeListeners.forEach(fn => fn(Object.fromEntries(keys.map(key => [key, {}])), 'local')), 0);

globalThis.chrome = {
  i18n: {
    getMessage: (key) => KO[key] ?? '',
    getUILanguage: () => 'ko',
  },
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? [...store.keys()] : [].concat(keys);
        const out = {};
        for (const key of list) if (store.has(key)) out[key] = structuredClone(store.get(key));
        return out;
      },
      async set(items) {
        writes.push(Object.keys(items));
        for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value));
        announce(Object.keys(items));
      },
      async remove(keys) {
        for (const key of [].concat(keys)) store.delete(key);
        announce([].concat(keys));
      },
    },
    onChanged: {addListener(fn) { changeListeners.push(fn); }},
    // Kept until the browser closes, across service worker restarts.
    session: {
      async get(key) { return sessionStore.has(key) ? {[key]: structuredClone(sessionStore.get(key))} : {}; },
      async set(items) { for (const [key, value] of Object.entries(items)) sessionStore.set(key, structuredClone(value)); },
      async remove(key) { sessionStore.delete(key); },
    },
  },
  action: {
    async setBadgeText({text}) { badge.text = text; },
    async setBadgeBackgroundColor({color}) { badge.color = color; },
    async setTitle({title}) { badge.title = title; },
  },
  runtime: {
    id: 'test-extension-id',
    getURL: path => `chrome-extension://test-extension-id/${path}`,
    onInstalled: {addListener(fn) { handlers.installed = fn; }},
    onStartup: {addListener(fn) { handlers.startup = fn; }},
    onMessage: {addListener(fn) { handlers.message = fn; }},
    lastError: undefined,
    // The Leeway helper, as Chrome reaches it: callback style, errors through
    // runtime.lastError. Behaves like helper/store.go (keyed by profile_id).
    sendNativeMessage(host, message, callback) {
      nativeCalls.push({host, message: structuredClone(message)});
      setTimeout(() => {
        if (!nativeHelper.installed) {
          globalThis.chrome.runtime.lastError = {message: 'Specified native messaging host not found.'};
          callback(undefined);
          globalThis.chrome.runtime.lastError = undefined;
          return;
        }
        if (message.type === 'put') nativeHelper.profiles.set(message.profile_id, {id: message.profile_id, label: message.label || 'Chrome', updated_at: new Date().toISOString(), snapshots: message.snapshots});
        if (message.type === 'remove') nativeHelper.profiles.delete(message.profile_id);
        callback({ok: true, version: '0.1.0', profiles: [...nativeHelper.profiles.values()].map(p => structuredClone(p))});
      }, 0);
    },
  },
  alarms: {create() {}, onAlarm: {addListener() {}}},
  permissions: {
    async contains({origins = [], permissions = []}) { return [...origins, ...permissions].every(item => granted.has(item)); },
    async remove({origins = [], permissions = []}) {
      writes.push(['permissions.remove', ...origins, ...permissions]);
      [...origins, ...permissions].forEach(item => granted.delete(item));
      // Chrome then fires onRemoved, as it does for a revoke in chrome://extensions.
      setTimeout(() => handlers.permissionsRemoved({origins, permissions}), 0);
      return true;
    },
    onAdded: {addListener(fn) { handlers.permissionsAdded = fn; }},
    onRemoved: {addListener(fn) { handlers.permissionsRemoved = fn; }},
  },
  // Tabs are whatever a test puts in openTabs; a tab answers SCAN_USAGE only
  // if tabAnswers has its id (chatgpt.js itself is test_chatgpt_parser.mjs).
  // tabCalls shows whether background touched the tabs at all.
  // query() answers like Chrome without the "tabs" permission: a tab's url and
  // title are there only for a site with a granted host permission, and the
  // url filter only applies to those tabs — the others come back without them.
  tabs: {
    async query(query) {
      tabCalls.push(['query', query]);
      const patterns = [].concat(query?.url ?? []);
      return openTabs.flatMap(tab => {
        if (!hostGranted(tab.url)) return [asSeen(tab)];
        return !patterns.length || patterns.some(p => matchesPattern(p, tab.url)) ? [asSeen(tab)] : [];
      });
    },
    // Throws unless a test sets newTab (the tab Chrome would make).
    async create(props) {
      tabCalls.push(['create', props.url]);
      if (!newTab) throw new Error('no new tabs in this test');
      openTabs.push(structuredClone(newTab));
      return asSeen(newTab);
    },
    async get(tabId) {
      const tab = openTabs.find(t => t.id === tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      return asSeen(tab);
    },
    async update(tabId, props) { tabCalls.push(['update', tabId, props]); return {id: tabId}; },
    async reload(tabId) { tabCalls.push(['reload', tabId]); },
    onUpdated: {addListener(fn) { handlers.tabUpdated = fn; }},
    onRemoved: {addListener(fn) { handlers.tabRemoved = fn; }},
    async sendMessage(tabId, message) {
      tabCalls.push(['sendMessage', tabId, message?.type]);
      if (tabGate) await tabGate; // a test can hold a scan mid-read (turn-off races)
      if (tabAnswers[tabId]) return structuredClone(tabAnswers[tabId]);
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  },
  windows: {async update(windowId, props) { tabCalls.push(['windows.update', windowId, props]); return {id: windowId}; }},
  scripting: {async executeScript({target}) {
    tabCalls.push(['executeScript', target.tabId]);
    throw new Error('Cannot access contents of the page.');
  }},
};
let nativeCalls = [];
const sessionStore = new Map();
let newTab = null;
const nativeHelper = {installed: true, profiles: new Map()};
let openTabs = [];
// Only the 'https://host/*' patterns this extension uses.
const matchesPattern = (pattern, url) => pattern.endsWith('/*') && String(url).startsWith(pattern.slice(0, -1));
const hostGranted = url => [...granted].some(pattern => matchesPattern(pattern, url));
// A tab as Chrome reports it without the "tabs" permission: url, title and
// favIconUrl only for a site with a granted host permission, pendingUrl only
// when its own site has one.
function asSeen(tab) {
  const out = structuredClone(tab);
  if (!hostGranted(tab.url)) { delete out.url; delete out.title; delete out.favIconUrl; }
  if (!hostGranted(tab.pendingUrl)) delete out.pendingUrl;
  return out;
}
let tabAnswers = {};
let tabGate = null;

// ---- fetch stub ------------------------------------------------------------

let routes = {}; // url → {status, body, type?, gate?}
let claudeRequests = [];
let chatgptRequests = [];
let fetched = []; // every URL fetch() was called with

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  fetched.push(url);
  if (url.startsWith('https://claude.ai/')) claudeRequests.push(url);
  if (url.startsWith('https://chatgpt.com/')) chatgptRequests.push({url, headers: init.headers || {}, credentials: init.credentials, redirect: init.redirect});
  const route = routes[url];
  if (route) {
    if (route.gate) await route.gate;
    if (route.throws) throw new TypeError(route.throws);
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return new Response(body, {status: route.status, headers: {'Content-Type': route.type || 'application/json'}});
  }
  throw new Error(`unexpected fetch: ${url}`);
};

await import('../extension/background.js');

// ---- helpers ---------------------------------------------------------------

// Senders as Chrome reports them: the popup, and a content script in a tab.
const POPUP = {id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup.html'};
const CHATGPT_TAB = {id: 'test-extension-id', tab: {id: 7}, url: 'https://chatgpt.com/#settings/Usage'};

function send(message, sender = POPUP) {
  return new Promise(resolve => {
    if (handlers.message(message, sender, resolve) !== true) resolve(undefined);
  });
}

async function waitFor(condition) {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise(resolve => setTimeout(resolve, 0));
  if (!condition()) throw new Error('waitFor: condition never became true');
}

function reset({enabled = [], permissions = []} = {}) {
  store.clear();
  granted.clear();
  for (const origin of permissions) granted.add(origin);
  store.set('enabledProviders', enabled);
  routes = {};
  claudeRequests = [];
  chatgptRequests = [];
  fetched = [];
  writes = [];
  tabCalls = [];
  openTabs = [];
  tabAnswers = {};
  tabGate = null;
  newTab = null;
  sessionStore.clear();
  nativeCalls = [];
  nativeHelper.installed = true;
  nativeHelper.profiles = new Map();
}

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

const get = key => store.get(key);
const pct = (snapshot, id) => snapshot?.limits.find(l => l.id === id)?.remaining_percent;

// Fresh objects every call, so no test can leak a mutation into another.
const chatgptOk = () => ({
  provider: 'chatgpt', value: '61%', status: 'ok',
  detail: '5-hour limit: 61% remaining · 4시간 20분 후 초기화 · weekly limit: 60% remaining',
  limits: [
    {id: 'chatgpt_5h', label: '5-hour limit', remaining_percent: 61, resets_at: null, reset_text: '4시간 20분 후 초기화'},
    {id: 'chatgpt_weekly', label: 'Weekly limit', remaining_percent: 60, resets_at: null, reset_text: null},
  ],
});
const chatgptFailed = () => ({
  provider: 'chatgpt', value: '?', status: 'parse_failed',
  detail: 'Settings > Usage route/dialog was not detected', limits: [],
});

function claudeAccount({orgsStatus = 200, sessionUsed = 40, weeklyUsed = 100} = {}) {
  routes['https://claude.ai/api/organizations'] = {
    status: orgsStatus,
    body: orgsStatus === 200 ? [{uuid: 'org-1', capabilities: ['chat']}] : {error: 'unauthorized'},
  };
  routes['https://claude.ai/api/organizations/org-1/usage'] = {
    status: 200,
    body: {limits: [
      {kind: 'session', percent: sessionUsed, resets_at: '2026-10-15T09:00:00Z'},
      {kind: 'weekly_all', percent: weeklyUsed, resets_at: '2026-10-20T00:00:00+00:00'},
    ]},
  };
}

// ---------------------------------------------------------------------------
console.log('\nusage message — the result is saved');
{
  reset({enabled: ['chatgpt']});
  const result = await send({type: 'usage', payload: chatgptOk()});
  const s = get('usage_chatgpt');
  check('usage_chatgpt.status', s?.status, 'ok');
  check('usage_chatgpt 5h', pct(s, 'chatgpt_5h'), 61);
  check('usage_chatgpt weekly', pct(s, 'chatgpt_weekly'), 60);
  check('primary_limit_id', s?.primary_limit_id, 'chatgpt_5h');
  check('usage_last_ok_chatgpt = latest', get('usage_last_ok_chatgpt'), s);
  check('reply says saved', [result?.ok, result?.status], [true, 'ok']);
  check('send result not stored (last_chatgpt)', get('last_chatgpt'), undefined);
}

console.log('\nusage message — publish() does not change the payload');
{
  reset({enabled: ['chatgpt']});
  const payload = chatgptOk();
  const before = JSON.stringify(payload);
  await send({type: 'usage', payload});
  check('payload object not mutated', JSON.stringify(payload), before);
  check('usage_chatgpt saved', get('usage_chatgpt')?.status, 'ok');
}

console.log('\nparse_failed after ok — last ok is kept');
{
  reset({enabled: ['chatgpt']});
  await send({type: 'usage', payload: chatgptOk()});
  await send({type: 'usage', payload: chatgptFailed()});
  check('usage_chatgpt.status', get('usage_chatgpt')?.status, 'parse_failed');
  check('usage_chatgpt.limits', get('usage_chatgpt')?.limits, []);
  check('usage_chatgpt.detail', get('usage_chatgpt')?.detail, 'Settings > Usage route/dialog was not detected');
  check('usage_last_ok_chatgpt still 61', pct(get('usage_last_ok_chatgpt'), 'chatgpt_5h'), 61);
}

console.log('\nprovider not enabled — dropped (stale content script)');
{
  reset({enabled: []});
  const result = await send({type: 'usage', payload: chatgptOk()});
  check('nothing saved', get('usage_chatgpt'), undefined);
  check('result says why', result?.error, 'provider-not-enabled');
}

const CLAUDE_HOST = 'https://claude.ai/*';
const CHATGPT_HOST = 'https://chatgpt.com/*';
const GEMINI_HOST = 'https://gemini.google.com/*';

console.log('\nturning off — PROVIDER_DISABLED: out of enabledProviders, then disabled saved, then the permission removed');
{
  reset({enabled: ['chatgpt', 'claude'], permissions: [CHATGPT_HOST, CLAUDE_HOST]});
  await send({type: 'usage', payload: chatgptOk()});
  writes = [];
  check('response', await send({type: 'PROVIDER_DISABLED', provider: 'chatgpt'}), {ok: true});
  await settle(); // Chrome's onRemoved, fired by permissions.remove()
  check('order', writes, [['enabledProviders'], ['usage_chatgpt', 'usage_last_ok_chatgpt'], ['permissions.remove', CHATGPT_HOST]]);
  check('enabledProviders', get('enabledProviders'), ['claude']);
  check('usage_chatgpt.status (disabled is let through), not flipped by onRemoved', get('usage_chatgpt')?.status, 'disabled');
  check('usage_last_ok_chatgpt cleared', get('usage_last_ok_chatgpt'), null);
  check('site permission removed, the other kept', [granted.has(CHATGPT_HOST), granted.has(CLAUDE_HOST)], [false, true]);
}

console.log('\nturning off while a refresh is in flight — the late result is dropped');
{
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  claudeAccount();
  let release;
  routes['https://claude.ai/api/organizations/org-1/usage'].gate = new Promise(resolve => { release = resolve; });
  const refresh = send({type: 'REFRESH_ALL'});
  await waitFor(() => claudeRequests.length === 2);
  await send({type: 'PROVIDER_DISABLED', provider: 'claude'});
  release();
  await refresh;
  await settle();
  check('usage_claude stays disabled', get('usage_claude')?.status, 'disabled');
  check('usage_last_ok_claude stays cleared', get('usage_last_ok_claude'), null);
}

console.log('\nturning on — PROVIDER_ENABLED (the popup was still open after the prompt)');
{
  reset({enabled: [], permissions: [CLAUDE_HOST]});
  claudeAccount();
  check('response', await send({type: 'PROVIDER_ENABLED', provider: 'claude'}), {ok: true});
  check('on when it answers', get('enabledProviders'), ['claude']);
  await settle(); // the refresh runs after the answer
  check('refreshed once', claudeRequests.length, 2);
  check('usage_claude', get('usage_claude')?.status, 'ok');
}
{
  reset({enabled: []});
  check('response', await send({type: 'PROVIDER_ENABLED', provider: 'claude'}), {ok: true});
  check('without the site permission: not turned on', get('enabledProviders'), []);
  check('no claude.ai request', claudeRequests, []);
  await send({type: 'PROVIDER_ENABLED', provider: 'gemini'});
  check('gemini without the site permission: not turned on either', get('enabledProviders'), []);
}

console.log('\nturning on — permissions.onAdded (Chrome closed the popup during the prompt)');
{
  reset({enabled: []});
  claudeAccount();
  granted.add(CLAUDE_HOST);
  await handlers.permissionsAdded({origins: [CLAUDE_HOST]});
  check('enabledProviders', get('enabledProviders'), ['claude']);
  check('refreshed', claudeRequests.length, 2);
  check('usage_claude', get('usage_claude')?.status, 'ok');
}
{
  reset({enabled: []});
  claudeAccount();
  granted.add(CLAUDE_HOST);
  await Promise.all([handlers.permissionsAdded({origins: [CLAUDE_HOST]}), send({type: 'PROVIDER_ENABLED', provider: 'claude'})]);
  await settle();
  check('onAdded and PROVIDER_ENABLED together: turned on once', get('enabledProviders'), ['claude']);
  check('onAdded and PROVIDER_ENABLED together: one refresh, not two', claudeRequests.length, 2);
}
{
  reset({enabled: []});
  granted.add('https://example.com/*');
  await handlers.permissionsAdded({origins: ['https://example.com/*']});
  check('another origin: nothing turned on', get('enabledProviders'), []);
}

console.log('\noff, then on again at once — the turn-on waits for the whole turn-off');
{
  // The popup locks its checkbox during a toggle; this is background's half.
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  claudeAccount();
  await Promise.all([send({type: 'PROVIDER_DISABLED', provider: 'claude'}), send({type: 'PROVIDER_ENABLED', provider: 'claude'})]);
  await settle();
  check('consistent: off and without the permission',
    [get('enabledProviders'), granted.has(CLAUDE_HOST), get('usage_claude')?.status], [[], false, 'disabled']);
  check('no refresh for the enable that found the permission gone', claudeRequests, []);
}

console.log('\nonly the extension\'s own pages talk to background; a web page (content script) is ignored');
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  check('PROVIDER_DISABLED from a ChatGPT tab: no answer', await send({type: 'PROVIDER_DISABLED', provider: 'chatgpt'}, CHATGPT_TAB), undefined);
  check('...and nothing changed', [get('enabledProviders'), granted.has(CHATGPT_HOST)], [['chatgpt'], true]);
  check('REFRESH_ALL from a ChatGPT tab: no answer', await send({type: 'REFRESH_ALL'}, CHATGPT_TAB), undefined);
  check('...and nothing fetched or touched', [chatgptRequests, tabCalls], [[], []]);
  check('usage from a ChatGPT tab: no answer', await send({type: 'usage', payload: chatgptOk()}, CHATGPT_TAB), undefined);
  check('...and not saved', get('usage_chatgpt'), undefined);
}

// ---- ChatGPT: its usage API (wham/usage) ------------------------------------
// Shaped after the response seen in a logged-in Chrome on 2026-10-15 (field
// names and types only — the values here are made up).
const TOKEN = 'test-access-token-1f2e3d';
const SESSION_TOKEN = 'test-session-token-9a8b7c';
const ACCOUNT = 'test-account-4d5e6f';
const EMAIL = 'someone@example.com';
const NOW_S = Math.floor(Date.now() / 1000);
const RESET_5H = NOW_S + 4 * 3600; // Unix seconds
const RESET_WEEK = NOW_S + 5 * 24 * 3600;
const windowOf = (seconds, used, resetAt) => ({used_percent: used, limit_window_seconds: seconds, reset_after_seconds: 3600, reset_at: resetAt});
function chatgptAccount({
  session = {accessToken: TOKEN, sessionToken: SESSION_TOKEN, account: {id: ACCOUNT, planType: 'plus'}, user: {email: EMAIL}},
  primary = windowOf(18000, 39, RESET_5H), secondary = windowOf(604800, 60, RESET_WEEK),
  usageStatus = 200, usage, usageType,
} = {}) {
  routes['https://chatgpt.com/api/auth/session'] = {status: 200, body: session};
  routes['https://chatgpt.com/backend-api/wham/usage'] = {status: usageStatus, type: usageType, body: usage ?? {
    user_id: 'user-test-7g8h', account_id: ACCOUNT, email: EMAIL, plan_type: 'plus',
    rate_limit: {allowed: true, limit_reached: false, primary_window: primary, secondary_window: secondary},
    code_review_rate_limit: null, additional_rate_limits: null,
    credits: {has_credits: false, unlimited: false, overage_limit_reached: false, balance: null},
  }};
}
const SECRETS = [TOKEN, SESSION_TOKEN, ACCOUNT, EMAIL, 'user-test-7g8h'];
const leaked = text => SECRETS.filter(secret => text.includes(secret));
const everythingStored = () => JSON.stringify([...store.entries()]);
const iso = seconds => new Date(seconds * 1000).toISOString();

console.log('\nChatGPT — read through its usage API, like Claude: no tab');
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount();
  check('response', await send({type: 'REFRESH_ALL'}), {ok: true});
  const s = get('usage_chatgpt');
  check('status', s?.status, 'ok');
  check('used → remaining, kind from the window length', s?.limits.map(l => [l.id, l.remaining_percent, l.resets_at]),
    [['chatgpt_5h', 61, iso(RESET_5H)], ['chatgpt_weekly', 40, iso(RESET_WEEK)]]);
  check('primary: 5-hour', s?.primary_limit_id, 'chatgpt_5h');
  check('no tab touched', tabCalls, []);
  check('requests', chatgptRequests.map(r => r.url), ['https://chatgpt.com/api/auth/session', 'https://chatgpt.com/backend-api/wham/usage']);
  check('session read with the browser\'s cookies', chatgptRequests[0]?.credentials, 'include');
  check('usage asked with the access token and the account',
    [chatgptRequests[1]?.headers.Authorization, chatgptRequests[1]?.headers['chatgpt-account-id']], [`Bearer ${TOKEN}`, ACCOUNT]);
  check('the token request follows no redirect', chatgptRequests[1]?.redirect, 'error');
  check('no token, session token, account id or email in storage', leaked(everythingStored()), []);
  const d = get('chatgpt_debug');
  check('diagnostics', [d?.source, d?.sessionStatus, d?.token, d?.usageStatus, d?.contentType, d?.plan, d?.windows, d?.failedStep],
    ['api', 200, true, 200, 'application/json', 'plus', [{seconds: 18000, used: 39}, {seconds: 604800, used: 60}], 'none']);
}

console.log('\nChatGPT — one 30-day window only (as seen 2026-10-15): it is the primary one');
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount({primary: windowOf(2592000, 0, RESET_5H), secondary: null});
  await send({type: 'REFRESH_ALL'});
  const s = get('usage_chatgpt');
  check('ok, monthly 100% left', [s?.status, s?.primary_limit_id, pct(s, 'chatgpt_monthly')], ['ok', 'chatgpt_monthly', 100]);
  check('no 5-hour entry: the answer has no 5-hour window', s?.limits.map(l => l.id), ['chatgpt_monthly']);
}

const noSecrets = label => check(label, leaked(everythingStored()), []);

console.log('\nChatGPT — signed out');
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount({session: {}});
  await send({type: 'REFRESH_ALL'});
  check('session without an access token → logged_out', get('usage_chatgpt')?.status, 'logged_out');
  check('usage API not called', chatgptRequests.map(r => r.url), ['https://chatgpt.com/api/auth/session']);
  check('no tab looked at either', tabCalls, []);
  check('diagnostics', [get('chatgpt_debug')?.token, get('chatgpt_debug')?.failedStep], [false, 'session: no access token (signed out?)']);
}
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount({usageStatus: 401, usage: {detail: `Unauthorized ${TOKEN} ${EMAIL}`}});
  await send({type: 'REFRESH_ALL'});
  check('usage API 401 with JSON → logged_out', get('usage_chatgpt')?.status, 'logged_out');
  check('...no page fallback when signed out', tabCalls, []);
  noSecrets('...nothing of the answer kept or sent');
}

console.log('\nChatGPT — blocked or refused another way: parse_failed, and an open usage tab may answer');
{
  // A check in front of the site (e.g. Cloudflare) answering the session request.
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount();
  routes['https://chatgpt.com/api/auth/session'] = {status: 403, body: '<!DOCTYPE html><title>Just a moment...</title>', type: 'text/html'};
  openTabs = [{id: 5, url: 'https://chatgpt.com/settings/usage?tab=overview'}];
  tabAnswers = {5: {ok: true, payload: chatgptOk(), debug: {url: 'https://chatgpt.com/settings/usage?tab=overview', routeDetected: true, failedStep: 'none'}}};
  await send({type: 'REFRESH_ALL'});
  check('session 403 HTML is not a sign-out: the usage tab is read', [get('usage_chatgpt')?.status, pct(get('usage_chatgpt'), 'chatgpt_5h')], ['ok', 61]);
  check('...usage API not called without a token', chatgptRequests.map(r => r.url), ['https://chatgpt.com/api/auth/session']);
  check('...diagnostics', get('chatgpt_debug')?.failedStep, 'session: HTTP 403, not JSON (text/html)');
}
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount({usageStatus: 403, usage: {detail: `Unusual activity ${EMAIL}`}});
  await send({type: 'REFRESH_ALL'});
  check('usage API 403 with JSON → parse_failed (not necessarily signed out)', get('usage_chatgpt')?.status, 'parse_failed');
  check('...detail', get('usage_chatgpt')?.detail, 'ChatGPT usage unavailable: usage: HTTP 403');
  check('...usage tabs looked for', tabCalls, [['query', {url: 'https://chatgpt.com/*'}]]);
  noSecrets('...nothing of the answer kept or sent');
}
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount();
  routes['https://chatgpt.com/backend-api/wham/usage'] = {throws: `Headers.append: "Bearer ${TOKEN}" is an invalid header value.`};
  await send({type: 'REFRESH_ALL'});
  check('a request that throws: only the error name is kept', get('usage_chatgpt')?.detail, 'ChatGPT usage unavailable: usage: request failed (TypeError)');
  noSecrets('...the token in its message goes nowhere');
}
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount({usageStatus: 403, usage: '<!DOCTYPE html><title>Just a moment...</title>', usageType: 'text/html'});
  await send({type: 'REFRESH_ALL'});
  check('HTML 403 (e.g. Cloudflare), no usage tab open → parse_failed', get('usage_chatgpt')?.status, 'parse_failed');
  check('detail', get('usage_chatgpt')?.detail, 'ChatGPT usage unavailable: usage: HTTP 403, not JSON (text/html)');
  check('only looked for open tabs — none opened', tabCalls, [['query', {url: 'https://chatgpt.com/*'}]]);
}
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount({primary: windowOf(18000, undefined, RESET_5H)});
  await send({type: 'REFRESH_ALL'});
  const s = get('usage_chatgpt');
  check('5-hour used_percent unreadable → parse_failed, weekly not promoted', [s?.status, s?.primary_limit_id], ['parse_failed', null]);
  check('...what the API could read is kept for display', s?.limits.map(l => [l.id, l.remaining_percent]), [['chatgpt_5h', null], ['chatgpt_weekly', 40]]);
  check('...the step is in the diagnostics, and usage tabs were looked for',
    [get('chatgpt_debug')?.failedStep, tabCalls], ['wham/usage: 5-hour limit has no usable used_percent', [['query', {url: 'https://chatgpt.com/*'}]]]);
}

console.log('\nChatGPT — the page fallback: Settings > Usage tabs only, no page text kept');
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount({usageStatus: 403, usage: '<!DOCTYPE html>', usageType: 'text/html'});
  openTabs = [
    {id: 6, url: 'https://chatgpt.com/c/some-conversation'},
    {id: 7, url: 'https://chatgpt.com/c/another-conversation#settings/Usage'},
    {id: 9, url: 'https://chatgpt.com/settings/usage', frozen: true},
    {id: 5, url: 'https://chatgpt.com/settings/usage?tab=overview'},
  ];
  tabAnswers = {5: {ok: true, payload: chatgptOk(), debug: {
    url: 'https://chatgpt.com/settings/usage?tab=overview#x', routeDetected: true, fiveHourLabelFound: true, weeklyLabelFound: true,
    percentages: ['61% 남음', 'How to reset 40% left of my budget'], resets: ['resets my router password'], selected: '61%', failedStep: 'none',
    fiveHourContext: 'a conversation title', weeklyContext: 'another title', snippets: ['private conversation title'],
  }}};
  await send({type: 'REFRESH_ALL'});
  check('the usage tab\'s values are saved', [get('usage_chatgpt')?.status, pct(get('usage_chatgpt'), 'chatgpt_5h')], ['ok', 61]);
  check('only the usage page asked: no conversation (not even with the dialog open), no frozen tab',
    tabCalls, [['query', {url: 'https://chatgpt.com/*'}], ['sendMessage', 5, 'SCAN_USAGE']]);
  const d = get('chatgpt_debug');
  check('diagnostics keep the API failure', d?.failedStep, 'usage: HTTP 403, not JSON (text/html)');
  check('...and of the page only the steps — no text from it', d?.dom, {
    usageTabs: 1, url: 'https://chatgpt.com/settings/usage', routeDetected: true, fiveHourLabelFound: true, weeklyLabelFound: true,
    percentages: ['61% 남음'], selected: '61%', failedStep: 'none',
  });
}
{
  // The tab doesn't answer and can't be injected into: that error is kept.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...rest); // skip scanTab's waits
  try {
    reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
    chatgptAccount({usageStatus: 500, usage: {error: 'server'}});
    openTabs = [{id: 5, url: 'https://chatgpt.com/settings/usage'}, {id: 8, url: 'https://chatgpt.com/settings/usage', discarded: true}];
    await send({type: 'REFRESH_ALL'});
    check('HTTP 500 → parse_failed', get('usage_chatgpt')?.status, 'parse_failed');
    check('a discarded tab is skipped', tabCalls.filter(call => call[1] === 8), []);
    check('injection error kept', get('chatgpt_debug')?.dom?.failedStep,
      'Could not inspect the usage tab: Could not establish connection. Receiving end does not exist. (inject: Cannot access contents of the page.)');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

console.log('\nChatGPT — turned off while a read is running: no tab touched, no diagnostics left');
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  chatgptAccount({usageStatus: 403, usage: '<!DOCTYPE html>', usageType: 'text/html'});
  let release;
  routes['https://chatgpt.com/backend-api/wham/usage'].gate = new Promise(resolve => { release = resolve; });
  openTabs = [{id: 5, url: 'https://chatgpt.com/settings/usage'}];
  tabAnswers = {5: {ok: true, payload: chatgptOk(), debug: {routeDetected: true}}};
  const refresh = send({type: 'REFRESH_ALL'});
  await waitFor(() => chatgptRequests.length === 2);
  await send({type: 'PROVIDER_DISABLED', provider: 'chatgpt'});
  release();
  await refresh;
  await settle();
  check('no usage tab touched after the turn-off', tabCalls, []);
  check('chatgpt_debug not written', get('chatgpt_debug'), undefined);
  check('still off', get('usage_chatgpt')?.status, 'disabled');
}
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST]});
  store.set('chatgpt_debug', {at: 1, source: 'api', failedStep: 'none'});
  await send({type: 'PROVIDER_DISABLED', provider: 'chatgpt'});
  check('turning ChatGPT off removes its diagnostics', get('chatgpt_debug'), undefined);
}

// ---- Gemini: read from an open usage tab ------------------------------------
// gemini_scan.js is tested in test_gemini_scan.mjs; here a tab just answers with
// the card text it would send. refreshGemini() opens no tab (CLAUDE.md §2).
const geminiCards = (current = {used: '0% 사용됨', reset: '오후 10:19에 초기화'}, weekly = {used: '0% 사용됨', reset: '10월 16일 오후 4:19에 초기화'}) => ({current, weekly});
const geminiAnswer = (cards = geminiCards()) => ({ok: true, cards, updated: '1시간 전에 업데이트됨', debug: {at: Date.now(), url: 'https://gemini.google.com/usage', failedStep: 'none'}});
const geminiTab = (id = 5) => [{id, url: 'https://gemini.google.com/usage'}];

console.log('\nGemini — read from an already-open usage tab (no tab opened)');
{
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST]});
  openTabs = [
    {id: 6, url: 'https://gemini.google.com/app/some-chat'},            // a conversation, not /usage
    {id: 7, url: 'https://evil.example/usage'},                          // /usage but not gemini.google.com
    {id: 8, url: 'https://gemini.google.com/usage', discarded: true},   // can't answer
    {id: 9, url: 'https://gemini.google.com/usage', frozen: true},
    {id: 5, url: 'https://gemini.google.com/usage'},
  ];
  tabAnswers = {5: geminiAnswer(), 6: geminiAnswer(), 7: geminiAnswer(), 8: geminiAnswer(), 9: geminiAnswer()};
  check('response', await send({type: 'REFRESH_ALL'}), {ok: true});
  const s = get('usage_gemini');
  check('status', s?.status, 'ok');
  check('0% used → 100 remaining, both', s?.limits.map(l => [l.id, l.remaining_percent]), [['gemini_5h', 100], ['gemini_weekly', 100]]);
  check('primary: 현재 사용량 (gemini_5h)', s?.primary_limit_id, 'gemini_5h');
  check('resets computed from the wording (both ISO strings)', s?.limits.map(l => typeof l.resets_at === 'string'), [true, true]);
  check('only the open usage tab read — none opened', tabCalls, [['query', {url: 'https://gemini.google.com/*'}], ['sendMessage', 5, 'SCAN_GEMINI']]);
  check('last ok saved', get('usage_last_ok_gemini')?.status, 'ok');
}

console.log('\nGemini — no open usage tab: parse_failed, last ok kept, nothing opened');
{
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST]});
  openTabs = geminiTab();
  tabAnswers = {5: geminiAnswer()};
  await send({type: 'REFRESH_ALL'});
  check('a value first', get('usage_gemini')?.status, 'ok');
  openTabs = [{id: 6, url: 'https://gemini.google.com/app'}]; // a chat tab, not /usage
  tabAnswers = {};
  tabCalls = [];
  await send({type: 'REFRESH_ALL'});
  check('no usage tab → parse_failed', get('usage_gemini')?.status, 'parse_failed');
  check('detail tells the user to open the usage page', get('usage_gemini')?.detail, 'No open Gemini usage tab (open gemini.google.com/usage)');
  check('the chat tab is not scanned, and no tab is opened', tabCalls, [['query', {url: 'https://gemini.google.com/*'}]]);
  check('last ok kept', pct(get('usage_last_ok_gemini'), 'gemini_5h'), 100);
}

console.log('\nGemini — a readable usage tab wins over one that is mid-render');
{
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST]});
  openTabs = [{id: 4, url: 'https://gemini.google.com/usage'}, {id: 5, url: 'https://gemini.google.com/usage'}];
  // Tab 4 answers first but its current card has no % yet; tab 5 is readable.
  tabAnswers = {4: geminiAnswer(geminiCards({used: null, reset: '오후 10:19에 초기화'})), 5: geminiAnswer()};
  await send({type: 'REFRESH_ALL'});
  check('the readable tab is used', [get('usage_gemini')?.status, pct(get('usage_gemini'), 'gemini_5h')], ['ok', 100]);
  check('both usage tabs were tried', tabCalls.filter(c => c[0] === 'sendMessage').map(c => c[1]), [4, 5]);
}

console.log('\nGemini — current card unreadable: parse_failed, weekly not promoted (CLAUDE.md §1)');
{
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST]});
  openTabs = geminiTab();
  tabAnswers = {5: geminiAnswer(geminiCards({used: null, reset: '오후 10:19에 초기화'}))};
  await send({type: 'REFRESH_ALL'});
  const s = get('usage_gemini');
  check('current without a % → parse_failed, no primary', [s?.status, s?.primary_limit_id], ['parse_failed', null]);
  check('gemini_5h listed null, weekly kept for display', s?.limits.map(l => [l.id, l.remaining_percent]), [['gemini_5h', null], ['gemini_weekly', 100]]);
}

console.log('\nGemini — enabled without the site permission → needs_permission');
{
  reset({enabled: ['gemini']});
  await send({type: 'REFRESH_ALL'});
  check('status', get('usage_gemini')?.status, 'needs_permission');
  check('no tab touched without permission', tabCalls, []);
}

console.log('\nGemini — turned off while a read is running: the late result is dropped');
{
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST]});
  openTabs = geminiTab();
  tabAnswers = {5: geminiAnswer()};
  let release;
  tabGate = new Promise(resolve => { release = resolve; });
  const refresh = send({type: 'REFRESH_ALL'});
  await waitFor(() => tabCalls.some(call => call[0] === 'sendMessage'));
  await send({type: 'PROVIDER_DISABLED', provider: 'gemini'});
  release();
  await refresh;
  await settle();
  check('stays disabled: the late ok is dropped', get('usage_gemini')?.status, 'disabled');
}

console.log('\ntoolbar badge — follows what is stored (CLAUDE.md §4)');
{
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  claudeAccount({sessionUsed: 40, weeklyUsed: 100});
  await send({type: 'REFRESH_ALL'});
  await settle();
  check('Claude 5-hour 60 → "60", green', [badge.text, badge.color], ['60', '#1e8e3e']);
  check('tooltip: service, limit, value', [badge.title.split('\n')[0], badge.title.split('\n')[1]?.startsWith('Claude: 5시간 60% 남음 · ')], ['Leeway', true]);
  granted.add(CHATGPT_HOST);
  store.set('enabledProviders', ['claude', 'chatgpt']);
  chatgptAccount({primary: windowOf(18000, 85, RESET_5H), secondary: windowOf(604800, 60, RESET_WEEK)});
  await send({type: 'REFRESH_ALL'});
  await settle();
  check('ChatGPT on too, lower: its 15, red', [badge.text, badge.color], ['15', '#d93025']);
  check('no token, account id or email in the badge', leaked(JSON.stringify(badge)), []);
  await send({type: 'PROVIDER_DISABLED', provider: 'chatgpt'});
  await settle();
  check('ChatGPT off → Claude\'s value again', badge.text, '60');
  await send({type: 'PROVIDER_DISABLED', provider: 'claude'});
  await settle();
  check('nothing on → empty', badge.text, '');
}
{
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  claudeAccount({orgsStatus: 401});
  await send({type: 'REFRESH_ALL'});
  await settle();
  check('on, no value (signed out, nothing ok before) → "?", grey', [badge.text, badge.color], ['?', '#80868b']);
  check('tooltip says why', badge.title, 'Leeway\nClaude: 로그인 필요');
}
{
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  claudeAccount({sessionUsed: 40});
  await send({type: 'REFRESH_ALL'});
  await settle();
  // The 2-minute refresh stops (e.g. the computer slept): the stored value ages.
  const old = get('usage_claude');
  old.collected_at = new Date(Date.now() - 7 * 60 * 1000).toISOString();
  await chrome.storage.local.set({usage_claude: old, usage_last_ok_claude: old});
  await settle();
  check('a value older than 6 minutes → grey', [badge.text, badge.color], ['60', '#80868b']);
  // The site permission is revoked in chrome://extensions, the value still stored.
  granted.delete(CLAUDE_HOST);
  await chrome.storage.local.set({usage_claude: get('usage_claude')});
  await settle();
  check('on but without the site permission → not counted: "?"', [badge.text, badge.title], ['?', 'Leeway\nClaude: 권한 필요']);
}
{
  // Turning on shows at once, before the first refresh has a value.
  reset({enabled: [], permissions: [CLAUDE_HOST]});
  await chrome.storage.local.set({usage_chatgpt: null});
  await settle();
  check('nothing on → empty', badge.text, '');
  claudeAccount({sessionUsed: 40});
  let release;
  routes['https://claude.ai/api/organizations/org-1/usage'].gate = new Promise(resolve => { release = resolve; });
  await send({type: 'PROVIDER_ENABLED', provider: 'claude'});
  await settle();
  check('just turned on, refresh still running → "?"', badge.text, '?');
  release();
  await settle();
  check('then its value', badge.text, '60');
}

console.log('\ntoolbar badge — Gemini counts too (read from its open usage tab)');
{
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST]});
  openTabs = geminiTab();
  tabAnswers = {5: geminiAnswer(geminiCards({used: '82% 사용됨', reset: '오후 10:19에 초기화'}))};
  await send({type: 'REFRESH_ALL'});
  await settle();
  check('Gemini 현재 사용량 18 left → "18", red', [badge.text, badge.color], ['18', '#d93025']);
  check('tooltip names Gemini and its 5-hour value', badge.title.split('\n')[1]?.startsWith('Gemini: 5시간 18% 남음 · '), true);
}

console.log('\nREFRESH_ALL — Claude: used → remaining, 0 stays 0');
{
  reset({enabled: ['claude'], permissions: ['https://claude.ai/*']});
  claudeAccount({sessionUsed: 40, weeklyUsed: 100});
  check('response', await send({type: 'REFRESH_ALL'}), {ok: true});
  check('claude.ai calls', claudeRequests, ['https://claude.ai/api/organizations', 'https://claude.ai/api/organizations/org-1/usage']);
  const s = get('usage_claude');
  check('status', s?.status, 'ok');
  check('claude_5h = 100 - 40', pct(s, 'claude_5h'), 60);
  check('claude_weekly = 100 - 100 → 0, not null', pct(s, 'claude_weekly'), 0);
  check('primary_limit_id', s?.primary_limit_id, 'claude_5h');
  check('resets_at normalized', s?.limits.map(l => l.resets_at), ['2026-10-15T09:00:00.000Z', '2026-10-20T00:00:00.000Z']);
  check('last ok saved', get('usage_last_ok_claude')?.status, 'ok');
}

console.log('\nREFRESH_ALL — Claude 5-hour unreadable: weekly is not promoted (CLAUDE.md §1)');
{
  reset({enabled: ['claude'], permissions: ['https://claude.ai/*']});
  claudeAccount({sessionUsed: 40, weeklyUsed: 100});
  await send({type: 'REFRESH_ALL'});
  claudeAccount({sessionUsed: null, weeklyUsed: 30});
  await send({type: 'REFRESH_ALL'});
  const s = get('usage_claude');
  check('claude_5h listed as null', s?.limits.map(l => [l.id, l.remaining_percent]), [['claude_5h', null], ['claude_weekly', 70]]);
  check('snapshot not ok', s?.status, 'parse_failed');
  check('no primary', s?.primary_limit_id, null);
  check('weekly kept for display', pct(s, 'claude_weekly'), 70);
  check('last ok untouched (still 60)', pct(get('usage_last_ok_claude'), 'claude_5h'), 60);
}

console.log('\nREFRESH_ALL — Claude 401 → logged_out, last ok kept');
{
  reset({enabled: ['claude'], permissions: ['https://claude.ai/*']});
  claudeAccount();
  await send({type: 'REFRESH_ALL'});
  claudeAccount({orgsStatus: 401});
  await send({type: 'REFRESH_ALL'});
  check('status', get('usage_claude')?.status, 'logged_out');
  check('usage_last_ok_claude kept (a 403 can be transient)', pct(get('usage_last_ok_claude'), 'claude_5h'), 60);
}

console.log('\nREFRESH_ALL — enabled without host permission → needs_permission');
{
  reset({enabled: ['claude']});
  await send({type: 'REFRESH_ALL'});
  check('status', get('usage_claude')?.status, 'needs_permission');
  check('no claude.ai request without permission', claudeRequests, []);
}

console.log('\npermission revoked in chrome://extensions → needs_permission');
{
  reset({enabled: ['chatgpt']});
  await send({type: 'usage', payload: chatgptOk()});
  await handlers.permissionsRemoved({origins: ['https://chatgpt.com/*']});
  check('status', get('usage_chatgpt')?.status, 'needs_permission');
  check('usage_last_ok_chatgpt', get('usage_last_ok_chatgpt'), null);
}

console.log('\ninstall / update — keys nothing reads any more are removed');
for (const reason of ['update', 'install']) {
  console.log(`  reason: ${reason}`);
  reset({enabled: ['chatgpt']});
  await send({type: 'usage', payload: chatgptOk()});
  store.set('enabledProviders', []); // makes the refreshAll() onInstalled schedules a no-op
  store.set('last_claude', {ok: false, at: 1, error: 'TypeError: fetch failed', status: 'ok'});
  store.set('last_chatgpt', {ok: true, at: 1, value: '61%', detail: '', status: 'ok'});
  store.set('chatgptUsageTabId', 123);
  store.set('bridge_token', 'tok-123'); // the removed 127.0.0.1 desktop bridge's pairing token
  // What the old chatgpt.js wrote from any ChatGPT tab, conversations included.
  store.set('chatgpt_debug', {at: 1, url: 'https://chatgpt.com/c/abc', snippets: ['my private chat line that resets things']});
  // Its setTimeout(refreshAll, 1000) runs now, while nothing is enabled — not a
  // second later, in the middle of a test that has Gemini on.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...rest);
  try { handlers.installed({reason}); }
  finally { globalThis.setTimeout = realSetTimeout; }
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
  check('last_claude removed', get('last_claude'), undefined);
  check('last_chatgpt removed', get('last_chatgpt'), undefined);
  check('chatgptUsageTabId removed', get('chatgptUsageTabId'), undefined);
  check('bridge_token removed', get('bridge_token'), undefined);
  check('old chatgpt_debug removed', get('chatgpt_debug'), undefined);
  check('usage_chatgpt kept', get('usage_chatgpt')?.status, 'ok');
  check('usage_last_ok_chatgpt kept', pct(get('usage_last_ok_chatgpt'), 'chatgpt_5h'), 61);
}

console.log('\nClaude plan and organizations — one sign-in, several organizations');
{
  // Shaped after a live claude.ai response read on 2026-10-27 (field names
  // only): a Max 5x chat organization and an API-only one whose usage is 403.
  // Names carry the email on a personal organization: they must go nowhere.
  const usageOf = (session, weekly) => ({five_hour: {utilization: session, resets_at: '2026-10-15T09:00:00Z'}, seven_day: {utilization: weekly, resets_at: '2026-10-20T00:00:00+00:00'}});
  const org = (uuid, capabilities, extra = {}) => ({uuid, name: `someone@example.com's Organization`, capabilities, ...extra});

  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  routes['https://claude.ai/api/organizations'] = {status: 200, body: [
    org('org-max', ['chat', 'claude_max'], {rate_limit_tier: 'default_claude_max_5x'}),
    org('org-api', ['api', 'api_individual']),
  ]};
  routes['https://claude.ai/api/organizations/org-max/usage'] = {status: 200, body: usageOf(4, 35)};
  await send({type: 'REFRESH_ALL'});
  let s = get('usage_claude');
  check('one chat organization: the API-only one is not read', claudeRequests, ['https://claude.ai/api/organizations', 'https://claude.ai/api/organizations/org-max/usage']);
  check('one chat organization: plan "Max 5x", no account list', [s?.status, s?.plan, s?.accounts], ['ok', 'Max 5x', undefined]);
  check('organization name (with the email) is not stored', JSON.stringify(s).includes('example.com'), false);

  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  routes['https://claude.ai/api/organizations'] = {status: 200, body: [
    org('org-max', ['chat', 'claude_max'], {rate_limit_tier: 'default_claude_max_20x'}),
    org('org-team', ['chat'], {raven_type: 'team'}),
    org('org-api', ['api']),
    org('org-pro', ['chat', 'claude_pro']),
  ]};
  routes['https://claude.ai/api/organizations/org-max/usage'] = {status: 200, body: usageOf(40, 100)};
  routes['https://claude.ai/api/organizations/org-team/usage'] = {status: 200, body: usageOf(90, 20)};
  routes['https://claude.ai/api/organizations/org-pro/usage'] = {status: 403, body: {error: 'forbidden'}};
  await send({type: 'REFRESH_ALL'});
  s = get('usage_claude');
  check('three chat organizations read, API-only skipped', claudeRequests.slice(1), [
    'https://claude.ai/api/organizations/org-max/usage',
    'https://claude.ai/api/organizations/org-team/usage',
    'https://claude.ai/api/organizations/org-pro/usage',
  ]);
  check('the first chat organization stays the main value', [s?.status, s?.plan, pct(s, 'claude_5h')], ['ok', 'Max 20x', 60]);
  check('accounts: plan, status and 5-hour value each',
    (s?.accounts || []).map(a => [a.plan, a.status, a.limits.find(l => l.id === 'claude_5h')?.remaining_percent ?? null]),
    [['Max 20x', 'ok', 60], ['Team', 'ok', 10], ['Pro', 'logged_out', null]]);
  check('weekly 0 in another account stays 0', s?.accounts?.[1]?.limits.find(l => l.id === 'claude_weekly')?.remaining_percent, 80);
  await settle();
  check('badge follows the main organization', badge.text, '60');

  const data = await send({type: 'OVERLAY_DATA'}, {id: 'test-extension-id', tab: {id: 9}, url: 'https://example.com/'});
  const claude = data.providers.find(p => p.provider === 'claude');
  check('overlay data carries the accounts', (claude?.accounts || []).map(a => [a.label, a.rows.find(r => r.primary)?.percent ?? '?']),
    [['Max 20x', '60%'], ['Team', '10%'], ['Pro', '?']]);
}

console.log('\nother Chrome profiles — off by default, then through the Leeway helper');
{
  const NM = 'nativeMessaging';
  const OTHER = 'fedcba9876543210';
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  claudeAccount({sessionUsed: 40, weeklyUsed: 100});
  await send({type: 'REFRESH_ALL'});
  check('off: the helper is never asked', nativeCalls.length, 0);
  check('turning on without the permission is refused', await send({type: 'PEERS_ENABLE', label: 'x'}), {ok: false, error: 'no-permission'});
  check('a content script cannot turn it on', await send({type: 'PEERS_ENABLE', label: 'x'}, CHATGPT_TAB), undefined);

  granted.add(NM);
  nativeHelper.profiles.set(OTHER, {id: OTHER, label: '개인', updated_at: new Date().toISOString(), snapshots: [
    {provider: 'claude', status: 'ok', collected_at: new Date().toISOString(), primary_limit_id: 'claude_5h', plan: 'Pro', limits: [{id: 'claude_5h', label: '5-hour limit', remaining_percent: 0, resets_at: null, reset_text: null}]},
  ]});
  const on = await send({type: 'PEERS_ENABLE', label: '  업무용\u0007 '});
  const settings = get('peer_settings');
  check('on: a random 16-hex profile id and the cleaned name', [settings?.on, /^[a-f0-9]{16}$/.test(settings?.id || ''), settings?.label], [true, true, '업무용']);
  const put = nativeCalls.at(-1)?.message;
  check("sent: this profile's shown values, no detail text", [put?.type, put?.label, put?.snapshots.map(x => [x.provider, x.status]), put?.snapshots.some(x => 'detail' in x)], ['put', '업무용', [['claude', 'ok']], false]);
  check('sent: nothing else (no url, cookie or token fields)', Object.keys(put || {}).sort(), ['label', 'profile_id', 'snapshots', 'type']);
  check('kept: the other profile only, not this one', [on?.ok, get('peer_profiles')?.profiles.map(p => p.id)], [true, [OTHER]]);

  const data = await send({type: 'OVERLAY_DATA'}, {id: 'test-extension-id', tab: {id: 9}, url: 'https://example.com/'});
  check('overlay: the other profile, its plan and 0% as 0%', data.peers?.map(p => [p.label, p.providers[0].plan, p.providers[0].rows[0].percent]), [['개인', 'Pro', '0%']]);

  nativeCalls = [];
  await send({type: 'REFRESH_ALL'});
  check('every refresh sends again', nativeCalls.map(c => c.message.type), ['put']);

  await send({type: 'PEERS_LABEL', label: '회사'});
  check('renamed: stored and sent', [get('peer_settings')?.label, nativeCalls.at(-1)?.message.label], ['회사', '회사']);

  nativeHelper.installed = false;
  await send({type: 'REFRESH_ALL'});
  check('helper not installed: an error code, no profiles', [get('peer_profiles')?.ok, get('peer_profiles')?.error, get('peer_profiles')?.profiles], [false, 'helper_missing', []]);
  nativeHelper.installed = true;

  const id = get('peer_settings')?.id;
  nativeCalls = [];
  check('turn off', await send({type: 'PEERS_DISABLE'}), {ok: true});
  check('off: this profile leaves the shared file', nativeCalls.map(c => [c.message.type, c.message.profile_id]), [['remove', id]]);
  check("off: the others' values dropped, permission given back", [get('peer_profiles'), get('peer_settings')?.on, granted.has(NM)], [undefined, false, false]);
  nativeCalls = [];
  await send({type: 'REFRESH_ALL'});
  check('off again: the helper is not asked', nativeCalls.length, 0);

  granted.add(NM);
  await send({type: 'PEERS_ENABLE', label: ''});
  check('on again: the same profile id', get('peer_settings')?.id, id);
  granted.delete(NM);
  await handlers.permissionsRemoved({permissions: [NM]});
  check('permission removed in chrome://extensions → off', [get('peer_settings')?.on, get('peer_profiles')], [false, undefined]);
  await settle();
}

console.log('\noverlay data — one providerView per provider, same as the popup');
{
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST]});
  claudeAccount({sessionUsed: 40, weeklyUsed: 100});
  await send({type: 'REFRESH_ALL'});
  // The overlay runs as our injected content script: sender.url is the host
  // page, sender.id is our extension. Read-only OVERLAY_DATA is allowed.
  const CONTENT = {id: 'test-extension-id', tab: {id: 9}, url: 'https://example.com/'};
  const data = await send({type: 'OVERLAY_DATA'}, CONTENT);
  check('content script may read overlay data', Array.isArray(data?.providers), true);
  const claude = data.providers.find(p => p.provider === 'claude');
  check('claude: enabled, ok, 5-hour primary 60%', [claude?.enabled, claude?.state, claude?.rows.find(r => r.primary)?.percent], [true, 'ok', '60%']);
  check('header: when the newest value was read', data.checked, KO.checked.replace('{age}', KO.just_now));
  const chatgpt = data.providers.find(p => p.provider === 'chatgpt');
  check('chatgpt: not enabled → off, no rows', [chatgpt?.enabled, chatgpt?.state, chatgpt?.rows], [false, 'off', []]);
  check('a content script still cannot trigger a refresh (state change stays page-only)', await send({type: 'REFRESH_ALL'}, CONTENT), undefined);
}

console.log('\nas shipped — no 127.0.0.1 permission: nothing goes to localhost, results unchanged');
{
  // The manifest grants no 127.0.0.1 origin, so this is the only path a
  // released build took; publish() now calls no bridge at all.
  reset({enabled: ['claude', 'chatgpt', 'gemini'], permissions: [CLAUDE_HOST, CHATGPT_HOST, GEMINI_HOST]});
  claudeAccount({sessionUsed: 40, weeklyUsed: 100});
  chatgptAccount();
  openTabs = geminiTab();
  tabAnswers = {5: geminiAnswer()};
  // Their setTimeout(refreshAll, 1000) runs now, inside this block — not a
  // second later, in the middle of the Gemini button tests below.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...rest);
  try { handlers.installed({reason: 'update'}); handlers.startup(); }
  finally { globalThis.setTimeout = realSetTimeout; }
  await settle();
  check('REFRESH_ALL', await send({type: 'REFRESH_ALL'}), {ok: true});
  await settle();
  check('claude', [get('usage_claude')?.status, pct(get('usage_claude'), 'claude_5h'), pct(get('usage_claude'), 'claude_weekly')], ['ok', 60, 0]);
  check('chatgpt', [get('usage_chatgpt')?.status, pct(get('usage_chatgpt'), 'chatgpt_5h'), pct(get('usage_chatgpt'), 'chatgpt_weekly')], ['ok', 61, 40]);
  check('gemini', [get('usage_gemini')?.status, pct(get('usage_gemini'), 'gemini_5h')], ['ok', 100]);
  check('last ok saved for each', ['claude', 'chatgpt', 'gemini'].map(p => get(`usage_last_ok_${p}`)?.status), ['ok', 'ok', 'ok']);
  claudeAccount({sessionUsed: null, weeklyUsed: 30});
  await send({type: 'REFRESH_ALL'});
  check('claude 5-hour unreadable: listed null, weekly not promoted',
    [get('usage_claude')?.status, get('usage_claude')?.primary_limit_id, get('usage_claude')?.limits.map(l => [l.id, l.remaining_percent])],
    ['parse_failed', null, [['claude_5h', null], ['claude_weekly', 70]]]);
  const reply = await send({type: 'usage', payload: chatgptOk()});
  check('usage message: saved', get('usage_chatgpt')?.status, 'ok');
  check('usage message: reply', [reply?.ok, reply?.status], [true, 'ok']);
  await send({type: 'PROVIDER_DISABLED', provider: 'gemini'});
  await settle();
  check('turned off', [get('usage_gemini')?.status, get('usage_last_ok_gemini')], ['disabled', null]);
  check('nothing fetched from 127.0.0.1', fetched.filter(url => url.startsWith('http://127.0.0.1')), []);
  check('no bridge_token written', get('bridge_token'), undefined);
}

console.log('\nno "tabs" permission — usage tabs are found through the site permission alone');
{
  // ChatGPT on (API refused, so its page fallback runs), Gemini on; Gemini's
  // and ChatGPT's usage tabs are open, and so is a Claude tab without a grant.
  reset({enabled: ['chatgpt', 'gemini'], permissions: [CHATGPT_HOST, GEMINI_HOST]});
  chatgptAccount({usageStatus: 403, usage: '<!DOCTYPE html>', usageType: 'text/html'});
  openTabs = [
    {id: 4, url: 'https://claude.ai/settings/usage', title: 'Claude'},
    {id: 5, url: 'https://chatgpt.com/settings/usage', title: 'ChatGPT'},
    {id: 6, url: 'https://gemini.google.com/usage', title: 'Gemini'},
  ];
  tabAnswers = {4: geminiAnswer(), 5: {ok: true, payload: chatgptOk(), debug: {url: 'https://chatgpt.com/settings/usage', routeDetected: true, failedStep: 'none'}}, 6: geminiAnswer()};
  await send({type: 'REFRESH_ALL'});
  check('chatgpt read from its usage tab', [get('usage_chatgpt')?.status, pct(get('usage_chatgpt'), 'chatgpt_5h')], ['ok', 61]);
  check('gemini read from its usage tab', [get('usage_gemini')?.status, pct(get('usage_gemini'), 'gemini_5h')], ['ok', 100]);
  check('only those two tabs were asked', tabCalls.filter(c => c[0] === 'sendMessage').map(c => c[1]).sort(), [5, 6]);
}
{
  // Without the site permission a usage tab comes back without its url, and
  // refresh asks no tab at all.
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST]});
  openTabs = geminiTab();
  tabAnswers = {5: geminiAnswer()};
  granted.delete(GEMINI_HOST);
  check('query without the grant: no url on the tab', (await chrome.tabs.query({url: 'https://gemini.google.com/*'})).map(t => [t.id, t.url]), [[5, undefined]]);
  await send({type: 'REFRESH_ALL'});
  check('needs_permission, no tab asked', [get('usage_gemini')?.status, tabCalls.filter(c => c[0] === 'sendMessage')], ['needs_permission', []]);
}

// ---- Gemini: the usage tab opened from the popup (OPEN_GEMINI_USAGE) -------
// The waits go through a fake clock (background.js's test seam): time moves
// only when a test says so, and every wait due by then runs in time order.
const clock = {
  t: 0, waits: [],
  now: () => clock.t,
  wait: ms => new Promise(resolve => clock.waits.push({at: clock.t + ms, resolve})),
  async to(target) {
    for (;;) {
      await settle();
      clock.waits.sort((x, y) => x.at - y.at);
      const next = clock.waits[0];
      if (!next || next.at > target) break;
      clock.waits.shift();
      clock.t = next.at;
      next.resolve();
    }
    clock.t = target;
    await settle();
  },
};
globalThis.__leewayGeminiOpenClock = clock;

const USAGE = 'https://gemini.google.com/usage';
const scans = () => tabCalls.filter(c => c[0] === 'sendMessage' && c[2] === 'SCAN_GEMINI').length;
const openWait = () => sessionStore.get('gemini_open_wait') ?? null;
const calls = name => tabCalls.filter(c => c[0] === name);
const noCard = () => geminiAnswer(geminiCards(null)); // weekly only: parse_failed
async function tabEvent(tabId, changeInfo, tab) { handlers.tabUpdated(tabId, changeInfo, tab); await settle(); }
// The tab as Chrome now reports it, so refreshGemini() finds it.
function tabIs(id, props) {
  const i = openTabs.findIndex(t => t.id === id);
  openTabs[i] = {...openTabs[i], ...props};
  for (const key of Object.keys(props)) if (props[key] === undefined) delete openTabs[i][key];
}
function openReset(opts = {}) {
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST], ...opts});
  clock.t = 0;
  clock.waits = [];
}
async function press() { await send({type: 'OPEN_GEMINI_USAGE'}); await settle(); }
// A new tab as tabs.create returns it: still loading, the URL only pending.
const loadingTab = (id = 11) => ({id, windowId: 3, url: '', pendingUrl: USAGE, status: 'loading'});
async function newTabLoaded(id = 11, answer = geminiAnswer()) {
  tabIs(id, {url: USAGE, pendingUrl: undefined, status: 'complete'});
  tabAnswers[id] = answer;
  await tabEvent(id, {status: 'complete'}, {id, url: USAGE, status: 'complete'});
}

console.log('\nGemini button — a usage tab already open and loaded: brought forward, read at once, no new tab');
{
  openReset();
  openTabs = [{id: 5, windowId: 2, url: USAGE, status: 'complete'}];
  tabAnswers = {5: geminiAnswer()};
  await press();
  check('no new tab', calls('create'), []);
  check('the tab made active, its window focused', [...calls('update'), ...calls('windows.update')], [['update', 5, {active: true}], ['windows.update', 2, {focused: true}]]);
  check('read without waiting (the clock has not moved)', [clock.t, scans()], [0, 1]);
  check('value saved', [get('usage_gemini')?.status, pct(get('usage_gemini'), 'gemini_5h')], ['ok', 100]);
  check('read ok → no wait left', openWait(), null);
  check('the Gemini page is never reloaded', calls('reload'), []);
}

console.log('\nGemini button — several usage tabs: the most recently used one (lastAccessed), chat tabs never');
{
  openReset();
  openTabs = [
    {id: 4, windowId: 1, url: USAGE, status: 'complete', lastAccessed: 100},
    {id: 5, windowId: 2, url: USAGE, status: 'complete', lastAccessed: 300},
    {id: 6, windowId: 1, url: 'https://gemini.google.com/app/some-chat', status: 'complete', lastAccessed: 900},
    {id: 7, windowId: 1, url: USAGE, status: 'complete', lastAccessed: 200},
  ];
  tabAnswers = {4: geminiAnswer(), 5: geminiAnswer(), 7: geminiAnswer()};
  await press();
  check('tab 5 (lastAccessed 300) brought forward', [...calls('update'), ...calls('windows.update')], [['update', 5, {active: true}], ['windows.update', 2, {focused: true}]]);

  openReset();
  openTabs = [{id: 4, windowId: 1, url: USAGE, status: 'complete'}, {id: 5, windowId: 2, url: USAGE, status: 'complete', active: true}];
  tabAnswers = {4: geminiAnswer(), 5: geminiAnswer()};
  await press();
  check('no lastAccessed (before Chrome 121): the active one', calls('update'), [['update', 5, {active: true}]]);
}

console.log('\nGemini button — the open usage tab is discarded or loading: it waits for complete like a new tab');
{
  openReset();
  openTabs = [{id: 5, windowId: 2, url: USAGE, status: 'unloaded', discarded: true}];
  tabAnswers = {5: geminiAnswer()};
  await press();
  check('brought forward, no new tab', [calls('create'), calls('update')], [[], [['update', 5, {active: true}]]]);
  check('not read yet; a wait for tab 5', [scans(), openWait()?.tabId, openWait()?.phase], [0, 5, 'waiting']);
  // Activating a discarded tab makes Chrome load it again.
  tabIs(5, {discarded: false, status: 'complete'});
  await tabEvent(5, {status: 'loading'}, {id: 5, url: USAGE, status: 'loading'});
  await tabEvent(5, {status: 'complete'}, {id: 5, url: USAGE, status: 'complete'});
  await clock.to(1999);
  check('nothing read before the 2s pause', scans(), 0);
  await clock.to(2000);
  check('read once after it', [scans(), get('usage_gemini')?.status, openWait()], [1, 'ok', null]);

  openReset();
  openTabs = [{id: 5, windowId: 2, url: USAGE, status: 'loading'}];
  await press();
  check('loading: a wait, nothing read', [scans(), openWait()?.phase], [0, 'waiting']);

  openReset();
  openTabs = [{id: 5, windowId: 2, url: USAGE, status: 'complete', frozen: true}];
  tabAnswers = {5: geminiAnswer()};
  await press();
  check('frozen: thawed by activation, not read at once', [calls('update').length, scans()], [1, 0]);
  tabIs(5, {frozen: undefined});
  await clock.to(2000);
  check('frozen: read after the 2s pause (no complete comes for it)', [scans(), get('usage_gemini')?.status], [1, 'ok']);
}

console.log('\nGemini button — only a chat tab open: it is not reused, a usage tab is opened and waited for');
{
  openReset();
  openTabs = [{id: 6, windowId: 1, url: 'https://gemini.google.com/app', status: 'complete'}];
  newTab = loadingTab();
  await press();
  check('a new usage tab, the chat tab not activated', [calls('create'), calls('update')], [[['create', USAGE]], []]);
  check('wait saved in storage.session', [openWait()?.tabId, openWait()?.openedAt, openWait()?.phase], [11, 0, 'waiting']);
  check('nothing injected yet (the chat tab never)', [scans(), calls('executeScript')], [0, []]);
}

console.log("\nGemini button — read 2s after the tab's complete, once; other tabs' events ignored");
{
  openReset();
  newTab = loadingTab();
  await press();
  await tabEvent(11, {status: 'loading'}, {id: 11, url: '', pendingUrl: USAGE, status: 'loading'});
  check('still loading (URL only pending): the wait stays', openWait()?.tabId, 11);
  openTabs.push({id: 12, url: USAGE, status: 'complete'});
  tabAnswers[12] = geminiAnswer();
  await tabEvent(12, {status: 'complete'}, {id: 12, url: USAGE, status: 'complete'});
  await clock.to(5000);
  check("another tab's complete: no read", [scans(), openWait()?.phase], [0, 'waiting']);
  openTabs.pop();
  delete tabAnswers[12];
  await newTabLoaded(11);
  await tabEvent(11, {status: 'complete'}, {id: 11, url: USAGE, status: 'complete'}); // a second complete
  await clock.to(6999);
  check('not before the pause', scans(), 0);
  await clock.to(7000);
  check('one read, value saved, wait gone', [scans(), get('usage_gemini')?.status, openWait()], [1, 'ok', null]);
  await clock.to(60000);
  check('the second complete and the 30s timer read nothing more', scans(), 1);
}

console.log('\nGemini button — no current card: again after 5s and 10s, no new read after 30s');
{
  openReset();
  newTab = loadingTab();
  await press();
  await clock.to(1000);
  await newTabLoaded(11, noCard());
  await clock.to(3000);
  check('first read at complete + 2s: parse_failed', [scans(), get('usage_gemini')?.status], [1, 'parse_failed']);
  await clock.to(8000);
  check('again 5s later', scans(), 2);
  await clock.to(18000);
  check('again 10s after that', scans(), 3);
  await clock.to(60000);
  check('then it stops, the wait gone', [scans(), openWait()], [3, null]);

  openReset();
  newTab = loadingTab();
  await press();
  await clock.to(20000);
  await newTabLoaded(11, noCard());
  await clock.to(60000);
  check('complete at 20s: reads at 22s and 27s, none at 37s', [scans(), openWait()], [2, null]);

  openReset();
  newTab = loadingTab();
  await press();
  await newTabLoaded(11, noCard());
  await clock.to(2000);
  tabAnswers[11] = geminiAnswer(); // the card has drawn
  await clock.to(60000);
  check('a retry that reads the card ends it', [scans(), get('usage_gemini')?.status, openWait()], [2, 'ok', null]);
}

console.log('\nGemini button — complete never comes within 30s: one read, then done');
{
  openReset();
  newTab = loadingTab();
  await press();
  tabIs(11, {url: USAGE, pendingUrl: undefined}); // committed, still loading
  tabAnswers[11] = noCard();
  await clock.to(29999);
  check('nothing before 30s', scans(), 0);
  await clock.to(30000);
  check('one read at 30s', scans(), 1);
  await clock.to(90000);
  check('no retries, the wait gone', [scans(), openWait()], [1, null]);
}

console.log('\nGemini button — the tab closes or leaves the usage screen: the wait goes');
{
  openReset();
  newTab = loadingTab();
  await press();
  handlers.tabRemoved(11);
  await settle();
  check('closed → no wait', openWait(), null);
  await clock.to(60000);
  check('and nothing read later', scans(), 0);

  openReset();
  newTab = loadingTab();
  await press();
  await tabEvent(11, {url: 'https://gemini.google.com/app'}, {id: 11, url: 'https://gemini.google.com/app', status: 'loading'});
  check('to a Gemini chat → no wait', openWait(), null);

  openReset();
  newTab = loadingTab();
  await press();
  // Another site: without the "tabs" permission Chrome leaves url out.
  await tabEvent(11, {status: 'loading'}, {id: 11, status: 'loading'});
  check('to another site (no url visible) → no wait', openWait(), null);
  await clock.to(60000);
  check('nothing read', scans(), 0);

  openReset();
  newTab = loadingTab();
  await press();
  await newTabLoaded(11, noCard());
  await clock.to(2000);
  handlers.tabRemoved(11);
  await settle();
  await clock.to(60000);
  check('closed between retries → the retries stop', [scans(), openWait()], [1, null]);
}

console.log('\nGemini button — Gemini off or without its permission: only the tab, no wait');
{
  openReset({enabled: []});
  openTabs = [{id: 5, windowId: 2, url: USAGE, status: 'complete'}];
  newTab = loadingTab();
  await press();
  check("off: a new tab (the open one isn't looked for), no wait, no read", [calls('create'), calls('update'), openWait(), scans()], [[['create', USAGE]], [], null, 0]);

  openReset({permissions: []});
  newTab = loadingTab();
  await press();
  check('no permission: a new tab, no wait, no tab looked up', [calls('create'), calls('query'), openWait()], [[['create', USAGE]], [], null]);
}

console.log('\nGemini button — a second press replaces the wait');
{
  openReset();
  newTab = loadingTab(11);
  await press();
  newTab = loadingTab(12);
  await press();
  check('the wait is for the new tab', openWait()?.tabId, 12);
  await newTabLoaded(11);
  await clock.to(5000);
  check("the first tab's complete is ignored", scans(), 0);
}

console.log('\nGemini button — the tab finished loading before the wait was saved');
{
  openReset();
  newTab = {id: 11, windowId: 3, url: USAGE, status: 'complete'};
  tabAnswers = {11: geminiAnswer()};
  await press();
  await clock.to(2000);
  check('read after the pause anyway', [scans(), get('usage_gemini')?.status, openWait()], [1, 'ok', null]);
}

console.log('\nGemini button — the service worker restarted: the wait in storage.session carries on');
{
  openReset();
  // Saved by the worker before this one; no timer of it survives.
  sessionStore.set('gemini_open_wait', {id: 'from-before', tabId: 11, openedAt: 0, phase: 'waiting'});
  openTabs = [{id: 11, url: USAGE, status: 'loading'}];
  await newTabLoaded(11);
  await clock.to(2000);
  check('its complete is read 2s later', [scans(), get('usage_gemini')?.status, openWait()], [1, 'ok', null]);

  openReset();
  sessionStore.set('gemini_open_wait', {id: 'from-before-2', tabId: 11, openedAt: 0, phase: 'waiting'});
  openTabs = [{id: 11, url: USAGE, status: 'loading'}];
  tabAnswers = {11: noCard()};
  clock.t = 31000; // its 30s timer went down with the old worker
  await tabEvent(11, {title: 'Gemini'}, {id: 11, url: USAGE, status: 'loading'});
  check('past 30s: the next event for the tab reads once and ends it', [scans(), openWait()], [1, null]);
}

console.log('\nGemini button — no "tabs" permission: the usage tab is found through the gemini.google.com grant alone');
{
  check('the manifest asks for no "tabs"', JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).permissions.includes('tabs'), false);
  openReset();
  // Most recently used: a tab on a site without a grant. Chrome gives its id
  // but no url, so it can't look like the usage page.
  openTabs = [
    {id: 9, windowId: 1, url: 'https://example.com/usage', title: 'Example', status: 'complete', lastAccessed: 900},
    {id: 5, windowId: 2, url: USAGE, title: 'Gemini', status: 'complete', lastAccessed: 100},
  ];
  check('the ungranted tab comes back without url or title', (await chrome.tabs.query({url: 'https://gemini.google.com/*'})).find(t => t.id === 9), {id: 9, windowId: 1, status: 'complete', lastAccessed: 900});
  tabCalls = [];
  tabAnswers = {5: geminiAnswer()};
  await press();
  check('the Gemini usage tab is brought forward and read', [calls('update'), scans(), get('usage_gemini')?.status], [[['update', 5, {active: true}]], 1, 'ok']);

  openReset();
  newTab = loadingTab();
  await press();
  await newTabLoaded(11); // its 'complete' as Chrome sends it: the tab's url seen through the grant
  check('a new tab: its url via the grant (tabs.get) is enough to wait and read', (await chrome.tabs.get(11)).url, USAGE);
  await clock.to(2000);
  check('...read 2s after complete', [scans(), get('usage_gemini')?.status, openWait()], [1, 'ok', null]);
}
delete globalThis.__leewayGeminiOpenClock;

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
