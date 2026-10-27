// Run with: node tests/test_formats.mjs
//
// Locks the per-locale composition that the native-speaker review drove: how
// view.js joins a duration (number/unit spacing), lays out a reset date, writes
// "N ago", and builds a toolbar tooltip line — in es, ja, zh and zh_TW (en as the
// baseline). The pieces live across messages.json (reset_date_fmt, badge_pct,
// badge_sep, badge_note_fmt, unit_*) and i18n.js (duration separators); this
// runs the real functions with each locale's real strings, so a stray space or
// a wrong bracket here fails the build.
import { formatReset, formatAge, badgeView } from '../extension/view.js';
import { separatorsFor } from '../extension/i18n.js';
import { toSnapshot } from '../extension/snapshot.js';
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

const dir = new URL('../extension/_locales/', import.meta.url);
const labelsFor = lang => {
  const raw = JSON.parse(readFileSync(new URL(`${lang}/messages.json`, dir), 'utf8'));
  const labels = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.message]));
  return {...labels, ...separatorsFor(lang)}; // what viewLabels() would build for this UI locale
};

const MIN = 60 * 1000;
const H = 60 * MIN;
const NOW = Date.UTC(2026, 9, 15, 4, 12, 0);
const TZ = 'UTC';
const iso = ms => new Date(ms).toISOString();
const resetIn = (labels, ms) => formatReset({resets_at: iso(NOW + ms)}, NOW, TZ, NOW, labels);
const resetAt = labels => formatReset({resets_at: '2026-10-20T00:00:00.000Z'}, NOW, TZ, NOW, labels); // Tue 00:00 UTC
const claudeBadge = labels => {
  const s = toSnapshot({provider: 'claude', status: 'ok', value: '', detail: '', limits: [
    {id: 'claude_5h', label: '5h', remaining_percent: 50, resets_at: iso(NOW + 2 * H + 48 * MIN), reset_text: null},
    {id: 'claude_weekly', label: 'wk', remaining_percent: 65, resets_at: '2026-10-20T00:00:00.000Z', reset_text: null},
  ]}, NOW);
  return badgeView([{name: 'Claude', enabled: true, permitted: true, latest: s, lastOk: s}], NOW, TZ, labels).title.split('\n')[1];
};

// Expected outputs, per the review. duration = 2 h 48 m; a date more than a day
// out = Tue 20 Oct 00:00; an age of 3 minutes; a fresh 50%-left badge line.
const CASES = {
  en:    {dur: 'resets in 2h 48m',                 date: 'resets 10/20 (Tue) 00:00',               age: '3m ago',     badge: 'Claude: 5-hour 50% left · resets in 2h 48m'},
  es:    {dur: 'se restablece en 2 h 48 min',      date: 'se restablece el mar 20/10 a las 00:00', age: 'hace 3 min', badge: 'Claude: 5 horas 50% restante · se restablece en 2 h 48 min'},
  ja:    {dur: 'あと2時間48分でリセット',            date: '10/20（火）00:00にリセット',               age: '3分前',      badge: 'Claude: 5時間 残り50%、あと2時間48分でリセット'},
  zh:    {dur: '2小时48分钟后重置',                  date: '10月20日（周二）00:00 重置',               age: '3分钟前',    badge: 'Claude: 5小时 剩余50% · 2小时48分钟后重置'},
  zh_TW: {dur: '2小時48分鐘後重設',                  date: '10/20（週二）00:00 重設',                  age: '3分鐘前',    badge: 'Claude: 5小時 剩餘50% · 2小時48分鐘後重設'},
};

for (const [lang, want] of Object.entries(CASES)) {
  console.log(`\n${lang} — composition`);
  const labels = labelsFor(lang);
  check(`${lang}: duration 2h 48m`, resetIn(labels, 2 * H + 48 * MIN), want.dur);
  check(`${lang}: reset date (more than a day out)`, resetAt(labels), want.date);
  check(`${lang}: age "3 min"`, formatAge(3 * MIN, labels), want.age);
  check(`${lang}: badge line shows remaining`, claudeBadge(labels), want.badge);
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
