// Run with: node tests/test_gemini.mjs
//
// extension/gemini.js is pure: it turns the text the content script pulls from
// the two usage cards into a collector result (USED percentages → remaining).
// `cards` is {current, weekly}, each null (card absent) or {used, reset} (the
// raw strings; `used` null when the "% 사용됨" couldn't be read). The DOM
// reading that produces `cards` is tested separately in test_gemini_scan.mjs.
import { usedPercent, resetOf, geminiPayload } from '../extension/gemini.js';
import { toSnapshot } from '../extension/snapshot.js';

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

const TZ = 'Asia/Seoul';
const NOW = Date.UTC(2026, 8, 4, 8, 0, 0); // 2026-09-04 17:00 in Seoul
const ids = limits => limits.map(l => [l.id, l.remaining_percent]);
const cards = (current, weekly) => ({current, weekly});
const USED0 = {current: {used: '0% 사용됨', reset: '오후 9:19에 초기화'}, weekly: {used: '0% 사용됨', reset: '9월 11일 오후 4:19에 초기화'}};

// ---------------------------------------------------------------------------
console.log('\nboth cards read (the shape the content script hands over)');
{
  const p = geminiPayload(USED0, NOW, TZ);
  check('status', p.status, 'ok');
  check('0% used → 100 remaining, both', ids(p.limits), [['gemini_5h', 100], ['gemini_weekly', 100]]);
  check('current reset: today 21:19 in Seoul', p.limits[0].resets_at, '2026-09-04T12:19:00.000Z');
  check('weekly reset: Sep 11 16:19 in Seoul', p.limits[1].resets_at, '2026-09-11T07:19:00.000Z');
  check('page wording kept', p.limits.map(l => l.reset_text), ['오후 9:19에 초기화', '9월 11일 오후 4:19에 초기화']);
  check('legacy value = current usage remaining', p.value, '100%');
  check('detail', p.detail, 'Current usage: 100% remaining, 오후 9:19에 초기화 · Weekly limit: 100% remaining, 9월 11일 오후 4:19에 초기화');
  const s = toSnapshot(p, NOW);
  check('stored: ok, primary = current usage (gemini_5h)', [s.status, s.primary_limit_id], ['ok', 'gemini_5h']);
}

console.log('\nused → remaining (CLAUDE.md §1: the page shows USED)');
{
  const some = (cur, wk) => geminiPayload(cards({used: `${cur}% 사용됨`, reset: '오후 9:19에 초기화'}, {used: `${wk}% 사용됨`, reset: '9월 11일 오후 4:19에 초기화'}), NOW, TZ);
  check('37% / 12.5% used → 63 / 87.5', ids(some(37, 12.5).limits), [['gemini_5h', 63], ['gemini_weekly', 87.5]]);
  const full = some(100, 0);
  check('100% used → 0, not "?"', [full.status, full.value, full.limits[0].remaining_percent], ['ok', '0%', 0]);
  check('over 100 → 0', some(130, 0).limits[0].remaining_percent, 0);
  check('reset read without a %', geminiPayload(cards({used: '5% 사용됨', reset: null}, null), NOW, TZ).limits[0].resets_at, null);
  check('decimal comma', usedPercent('12,5% 사용됨'), 12.5);
  check('English wording', usedPercent('40% used'), 40);
  check('no "% 사용됨" → null', usedPercent('현재 사용량'), null);
  check('not a string → null', usedPercent(37), null);
}

console.log('\nunreadable or missing cards');
{
  const noValue = geminiPayload(cards({used: null, reset: '오후 9:19에 초기화'}, {used: '0% 사용됨', reset: '9월 11일 오후 4:19에 초기화'}), NOW, TZ);
  check('current card without its %: parse_failed', [noValue.status, noValue.detail], ['parse_failed', 'Gemini current usage has no "% 사용됨"']);
  check('...listed as null, weekly kept', ids(noValue.limits), [['gemini_5h', null], ['gemini_weekly', 100]]);
  check('...current reset still kept for display', noValue.limits[0].resets_at, '2026-09-04T12:19:00.000Z');
  const stored = toSnapshot(noValue, NOW);
  check('...stored with no primary (weekly not promoted)', [stored.status, stored.primary_limit_id], ['parse_failed', null]);
  const noCurrent = geminiPayload(cards(null, {used: '0% 사용됨', reset: '9월 11일 오후 4:19에 초기화'}), NOW, TZ);
  check('no current-usage card: parse_failed, weekly kept for display', [noCurrent.status, noCurrent.detail, ids(noCurrent.limits)],
    ['parse_failed', 'Gemini current-usage card not found', [['gemini_weekly', 100]]]);
  const noCards = geminiPayload(cards(null, null), NOW, TZ);
  check('no cards at all (e.g. signed out / wrong page)', [noCards.status, noCards.detail, noCards.limits], ['parse_failed', 'Gemini usage cards not found', []]);
  check('cards not an object', [geminiPayload(undefined, NOW, TZ).status, geminiPayload(null, NOW, TZ).status, geminiPayload('x', NOW, TZ).status], ['parse_failed', 'parse_failed', 'parse_failed']);
}

console.log('\nreset wording → time (Korean; read against when the page was read)');
{
  const at = (text, nowMs = NOW, zone = TZ) => resetOf(text, nowMs, zone)?.iso ?? null;
  check('later today', at('오후 9:19에 초기화'), '2026-09-04T12:19:00.000Z');
  check('already past today → tomorrow', at('오후 4:19에 초기화'), '2026-09-05T07:19:00.000Z');
  check('a minute ago still counts as now', at('오후 4:59에 초기화'), '2026-09-04T07:59:00.000Z');
  check('오전 12:05 is 00:05', at('오전 12:05에 초기화'), '2026-09-04T15:05:00.000Z');
  check('오후 12:30 is 12:30', at('오후 12:30에 초기화'), '2026-09-05T03:30:00.000Z');
  check('with a date', at('9월 11일 오후 4:19에 초기화'), '2026-09-11T07:19:00.000Z');
  check('a date before now → next year', at('1월 2일 오전 9:00에 초기화', Date.UTC(2026, 11, 30, 0, 0)), '2027-01-02T00:00:00.000Z');
  check('time zone honoured (UTC)', at('오후 9:19에 초기화', NOW, 'UTC'), '2026-09-04T21:19:00.000Z');
  check('daylight saving (New York, after it ended)', at('11월 1일 오후 4:19에 초기화', Date.UTC(2026, 9, 30), 'America/New_York'), '2026-11-01T21:19:00.000Z');
  check('daylight saving (New York, before it ended)', at('10월 31일 오후 4:19에 초기화', Date.UTC(2026, 9, 30), 'America/New_York'), '2026-10-31T20:19:00.000Z');
  check('daylight saving, hours after the change (New York 05:30 EST)', at('11월 1일 오전 5:30에 초기화', Date.UTC(2026, 9, 30), 'America/New_York'), '2026-11-01T10:30:00.000Z');
  check('wording kept', resetOf('주간 한도 9월 11일 오후 4:19에 초기화 0% 사용됨', NOW, TZ)?.text, '9월 11일 오후 4:19에 초기화');
  check('no such wording → null', resetOf('Resets at 9:19 PM', NOW, TZ), null);
  check('impossible time → null', resetOf('오후 25:19에 초기화', NOW, TZ), null);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
