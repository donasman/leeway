// Run with: node tests/test_locales.mjs
//
// Every extension/_locales/<lang>/messages.json must define exactly the same
// keys as the default locale (en) — otherwise a user in that language would see
// English for the missing strings — and every templated message must keep its
// {token} placeholders (view.js's fill() substitutes them). No message is empty.
import { readFileSync, readdirSync } from 'node:fs';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  [${ok ? PASS : FAIL}] ${label}: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  ok ? passed++ : failed++;
}

const dir = new URL('../extension/_locales/', import.meta.url);
const load = lang => JSON.parse(readFileSync(new URL(`${lang}/messages.json`, dir), 'utf8'));
const langs = readdirSync(dir, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name).sort();
const tokensOf = message => [...String(message).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

console.log('\n_locales — every language matches the default (en) keys and placeholders');
check('the five planned locales + en are present', langs, ['en', 'es', 'ja', 'ko', 'zh_CN', 'zh_TW']);
const en = load('en');
const enKeys = Object.keys(en).sort();

for (const lang of langs) {
  const messages = load(lang);
  check(`${lang}: same keys as en`, Object.keys(messages).sort(), enKeys);
  // Chrome caps the manifest "name" at 75 and "description" at 132 characters;
  // both are localized (__MSG_appName__ / __MSG_appDesc__), so guard every locale.
  check(`${lang}.appName: within Chrome's 75-char limit`, [...(messages.appName?.message ?? '')].length <= 75, true);
  check(`${lang}.appDesc: within Chrome's 132-char limit`, [...(messages.appDesc?.message ?? '')].length <= 132, true);
  for (const key of enKeys) {
    if (!messages[key]) continue; // the key-set check already flagged the gap
    check(`${lang}.${key}: placeholders preserved`, tokensOf(messages[key].message), tokensOf(en[key].message));
    check(`${lang}.${key}: non-empty`, String(messages[key].message ?? '').length > 0, true);
  }
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
