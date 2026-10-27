// Run with: node tests/test_manifest.mjs
//
// The permissions extension/manifest.json asks for (CLAUDE.md §3). Required
// permissions show their warnings at install, so the list is pinned: "tabs"
// ("Read your browsing history") is not needed — tabs.query() sees a usage
// tab's url through the site's host permission, the popup sees the active
// tab's through activeTab. Site access stays optional, one host per service.
import { readFileSync } from 'node:fs';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  [${ok ? PASS : FAIL}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

console.log('\nmanifest — MV3 and its permissions');
check('manifest_version', manifest.manifest_version, 3);
check('name, version, service worker present', [typeof manifest.name, typeof manifest.version, manifest.background?.service_worker], ['string', 'string', 'background.js']);
check('required permissions', manifest.permissions, ['storage', 'alarms', 'scripting', 'activeTab']);
check('no "tabs"', (manifest.permissions || []).includes('tabs'), false);
check('optional permissions', manifest.optional_permissions, ['nativeMessaging']);
check('no install-time host permissions', manifest.host_permissions, undefined);
check('optional host permissions: one per service', manifest.optional_host_permissions, ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://gemini.google.com/*']);
check('no <all_urls> anywhere', JSON.stringify(manifest).includes('<all_urls>'), false);
check('no static content scripts', manifest.content_scripts, undefined);

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
