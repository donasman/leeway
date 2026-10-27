// Run with: node tests/test_background.mjs
//
// Loads the real extension/background.js (no copied source, CLAUDE.md §5) with
// an in-memory chrome.* stub and a fetch stub, then drives it with the same
// runtime messages the popup and chatgpt.js send. Only the paths that need no
// browser tab are covered (Claude collection, content-script results,
// enable/disable) — ChatGPT tab scanning stays with test_chatgpt_parser.mjs.
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
    onStartup: {addListener() {}},
    onMessage: {addListener(fn) { handlers.message = fn; }},
  },
  alarms: {create() {}, onAlarm: {addListener() {}}},
  permissions: {
    async contains({origins}) { return origins.every(origin => granted.has(origin)); },
    async remove({origins}) {
      writes.push(['permissions.remove', ...origins]);
      origins.forEach(origin => granted.delete(origin));
      // Chrome then fires onRemoved, as it does for a revoke in chrome://extensions.
      setTimeout(() => handlers.permissionsRemoved({origins}), 0);
      return true;
    },
    onAdded: {addListener(fn) { handlers.permissionsAdded = fn; }},
    onRemoved: {addListener(fn) { handlers.permissionsRemoved = fn; }},
  },
  // Tabs are whatever a test puts in openTabs; a tab answers SCAN_USAGE only
  // if tabAnswers has its id (chatgpt.js itself is test_chatgpt_parser.mjs).
  // tabCalls shows whether background touched the tabs at all.
  tabs: {
    async query(query) { tabCalls.push(['query', query]); return structuredClone(openTabs); },
    async create(props) { tabCalls.push(['create', props.url]); throw new Error('no new tabs in this test'); },
    async sendMessage(tabId, message) {
      tabCalls.push(['sendMessage', tabId, message?.type]);
      if (tabGate) await tabGate; // a test can hold a scan mid-read (turn-off races)
      if (tabAnswers[tabId]) return structuredClone(tabAnswers[tabId]);
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  },
  scripting: {async executeScript({target}) {
    tabCalls.push(['executeScript', target.tabId]);
    throw new Error('Cannot access contents of the page.');
  }},
};
let openTabs = [];
let tabAnswers = {};
let tabGate = null;

// ---- fetch stub ------------------------------------------------------------

const bridge = {up: false, requests: []};
let routes = {}; // url → {status, body, type?, gate?}
let claudeRequests = [];
let chatgptRequests = [];

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1:8765/')) {
    if (!bridge.up) throw new TypeError('fetch failed');
    bridge.requests.push({url, method: init.method || 'GET', headers: init.headers || {}, body: init.body});
    return new Response('{"ok":true}', {status: 200, headers: {'Content-Type': 'application/json'}});
  }
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

function reset({enabled = [], permissions = [], bridgeUp = false, token} = {}) {
  store.clear();
  granted.clear();
  for (const origin of permissions) granted.add(origin);
  if (bridgeUp) granted.add('http://127.0.0.1:8765/*'); // bridge host is an optional permission now; a reachable bridge implies it was granted
  store.set('enabledProviders', enabled);
  if (token) store.set('bridge_token', token);
  bridge.up = bridgeUp;
  bridge.requests = [];
  routes = {};
  claudeRequests = [];
  chatgptRequests = [];
  writes = [];
  tabCalls = [];
  openTabs = [];
  tabAnswers = {};
  tabGate = null;
}

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

const get = key => store.get(key);
const pct = (snapshot, id) => snapshot?.limits.find(l => l.id === id)?.remaining_percent;
const bridgeBodies = () => bridge.requests.map(r => JSON.parse(r.body));

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
console.log('\nbridge down — the result is still saved');
{
  reset({enabled: ['chatgpt']});
  const result = await send({type: 'usage', payload: chatgptOk()});
  const s = get('usage_chatgpt');
  check('usage_chatgpt.status', s?.status, 'ok');
  check('usage_chatgpt 5h', pct(s, 'chatgpt_5h'), 61);
  check('usage_chatgpt weekly', pct(s, 'chatgpt_weekly'), 60);
  check('primary_limit_id', s?.primary_limit_id, 'chatgpt_5h');
  check('usage_last_ok_chatgpt = latest', get('usage_last_ok_chatgpt'), s);
  check('bridge failure only in the reply', result?.ok, false);
  check('send result not stored (last_chatgpt)', get('last_chatgpt'), undefined);
}

console.log('\nbridge up — payload reaches it unchanged');
{
  reset({enabled: ['chatgpt'], bridgeUp: true, token: 'tok-123'});
  const payload = chatgptOk();
  const before = JSON.stringify(payload);
  const result = await send({type: 'usage', payload});
  check('one POST', bridge.requests.map(r => `${r.method} ${r.url}`), ['POST http://127.0.0.1:8765/usage']);
  check('body is byte-identical to the payload before publish()', bridge.requests[0]?.body, before);
  check('payload object not mutated', JSON.stringify(payload), before);
  check('X-Bridge-Token', bridge.requests[0]?.headers['X-Bridge-Token'], 'tok-123');
  check('reply says sent', result?.ok, true);
  check('send result not stored (last_chatgpt)', get('last_chatgpt'), undefined);
  check('usage_chatgpt saved too', get('usage_chatgpt')?.status, 'ok');
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
  reset({enabled: [], bridgeUp: true});
  const result = await send({type: 'usage', payload: chatgptOk()});
  check('nothing saved', get('usage_chatgpt'), undefined);
  check('nothing sent to bridge', bridge.requests.length, 0);
  check('result says why', result?.error, 'provider-not-enabled');
}

const CLAUDE_HOST = 'https://claude.ai/*';
const CHATGPT_HOST = 'https://chatgpt.com/*';
const GEMINI_HOST = 'https://gemini.google.com/*';

console.log('\nturning off — PROVIDER_DISABLED: out of enabledProviders, then disabled saved, then the permission removed');
{
  reset({enabled: ['chatgpt', 'claude'], permissions: [CHATGPT_HOST, CLAUDE_HOST], bridgeUp: true});
  await send({type: 'usage', payload: chatgptOk()});
  writes = [];
  check('response', await send({type: 'PROVIDER_DISABLED', provider: 'chatgpt'}), {ok: true});
  await settle(); // Chrome's onRemoved, fired by permissions.remove()
  check('order', writes, [['enabledProviders'], ['usage_chatgpt', 'usage_last_ok_chatgpt'], ['permissions.remove', CHATGPT_HOST]]);
  check('enabledProviders', get('enabledProviders'), ['claude']);
  check('usage_chatgpt.status (disabled is let through), not flipped by onRemoved', get('usage_chatgpt')?.status, 'disabled');
  check('usage_last_ok_chatgpt cleared', get('usage_last_ok_chatgpt'), null);
  check('site permission removed, the other kept', [granted.has(CHATGPT_HOST), granted.has(CLAUDE_HOST)], [false, true]);
  check('bridge told too', bridgeBodies().map(b => b.status), ['ok', 'disabled']);
}

console.log('\nturning off while a refresh is in flight — the late result is dropped');
{
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST], bridgeUp: true});
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
  check('bridge never saw the late ok', bridgeBodies().map(b => b.status), ['disabled']);
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
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST], bridgeUp: true});
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
  check('...nor sent to the bridge', leaked(JSON.stringify(bridge.requests)), []);
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

const noSecrets = label => check(label, leaked(everythingStored() + JSON.stringify(bridge.requests)), []);

console.log('\nChatGPT — signed out');
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST], bridgeUp: true});
  chatgptAccount({session: {}});
  await send({type: 'REFRESH_ALL'});
  check('session without an access token → logged_out', get('usage_chatgpt')?.status, 'logged_out');
  check('usage API not called', chatgptRequests.map(r => r.url), ['https://chatgpt.com/api/auth/session']);
  check('no tab looked at either', tabCalls, []);
  check('diagnostics', [get('chatgpt_debug')?.token, get('chatgpt_debug')?.failedStep], [false, 'session: no access token (signed out?)']);
}
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST], bridgeUp: true});
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
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST], bridgeUp: true});
  chatgptAccount({usageStatus: 403, usage: {detail: `Unusual activity ${EMAIL}`}});
  await send({type: 'REFRESH_ALL'});
  check('usage API 403 with JSON → parse_failed (not necessarily signed out)', get('usage_chatgpt')?.status, 'parse_failed');
  check('...detail', get('usage_chatgpt')?.detail, 'ChatGPT usage unavailable: usage: HTTP 403');
  check('...usage tabs looked for', tabCalls, [['query', {url: 'https://chatgpt.com/*'}]]);
  noSecrets('...nothing of the answer kept or sent');
}
{
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST], bridgeUp: true});
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
  reset({enabled: ['chatgpt'], permissions: [CHATGPT_HOST], bridgeUp: true});
  chatgptAccount({primary: windowOf(18000, undefined, RESET_5H)});
  await send({type: 'REFRESH_ALL'});
  const s = get('usage_chatgpt');
  check('5-hour used_percent unreadable → parse_failed, weekly not promoted', [s?.status, s?.primary_limit_id], ['parse_failed', null]);
  check('...what the API could read is kept for display', s?.limits.map(l => [l.id, l.remaining_percent]), [['chatgpt_5h', null], ['chatgpt_weekly', 40]]);
  check('...the step is in the diagnostics, and usage tabs were looked for',
    [get('chatgpt_debug')?.failedStep, tabCalls], ['wham/usage: 5-hour limit has no usable used_percent', [['query', {url: 'https://chatgpt.com/*'}]]]);
  check('...the bridge gets value "?"', bridgeBodies().map(b => b.value), ['?']);
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
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST], bridgeUp: true});
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
  check('bridge got the gemini payload', bridgeBodies().map(b => [b.provider, b.status]), [['gemini', 'ok']]);
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
  reset({enabled: ['gemini'], permissions: [GEMINI_HOST], bridgeUp: true});
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
  check('bridge never saw the late ok', bridgeBodies().map(b => b.status), ['disabled']);
}

console.log('\ntoolbar badge — follows what is stored (CLAUDE.md §4)');
{
  reset({enabled: ['claude'], permissions: [CLAUDE_HOST], bridgeUp: true});
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
  reset({enabled: ['claude'], permissions: ['https://claude.ai/*'], bridgeUp: true});
  claudeAccount({sessionUsed: 40, weeklyUsed: 100});
  await send({type: 'REFRESH_ALL'});
  claudeAccount({sessionUsed: null, weeklyUsed: 30});
  await send({type: 'REFRESH_ALL'});
  const sent = bridgeBodies()[1];
  check('bridge: claude_5h listed as null', sent?.limits.map(l => [l.id, l.remaining_percent]), [['claude_5h', null], ['claude_weekly', 70]]);
  check('bridge: legacy value', sent?.value, '?');
  const s = get('usage_claude');
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
{
  reset({enabled: ['chatgpt']});
  await send({type: 'usage', payload: chatgptOk()});
  store.set('enabledProviders', []); // makes the refreshAll() onInstalled schedules a no-op
  store.set('last_claude', {ok: false, at: 1, error: 'TypeError: fetch failed', status: 'ok'});
  store.set('last_chatgpt', {ok: true, at: 1, value: '61%', detail: '', status: 'ok'});
  store.set('chatgptUsageTabId', 123);
  // What the old chatgpt.js wrote from any ChatGPT tab, conversations included.
  store.set('chatgpt_debug', {at: 1, url: 'https://chatgpt.com/c/abc', snippets: ['my private chat line that resets things']});
  handlers.installed({reason: 'update'});
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
  check('last_claude removed', get('last_claude'), undefined);
  check('last_chatgpt removed', get('last_chatgpt'), undefined);
  check('chatgptUsageTabId removed', get('chatgptUsageTabId'), undefined);
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
  const chatgpt = data.providers.find(p => p.provider === 'chatgpt');
  check('chatgpt: not enabled → off, no rows', [chatgpt?.enabled, chatgpt?.state, chatgpt?.rows], [false, 'off', []]);
  check('a content script still cannot trigger a refresh (state change stays page-only)', await send({type: 'REFRESH_ALL'}, CONTENT), undefined);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
