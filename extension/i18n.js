// Builds the labels map that the pure view.js takes — view.js can't call
// chrome.i18n itself (CLAUDE.md §2 pure layer). popup.js and background.js pass
// viewLabels() into it; tests build the same map from a _locales messages file.
// Message templates use {token} placeholders (not $-placeholders), so
// chrome.i18n.getMessage returns them intact and view.js's fill() substitutes.

const VIEW_LABEL_KEYS = [
  'status_ok', 'status_stale', 'status_parse_failed', 'status_logged_out',
  'status_needs_permission', 'status_waiting', 'status_off',
  'limit_5h', 'limit_weekly', 'limit_monthly',
  'unit_day', 'unit_hour', 'unit_minute',
  'reset_in', 'reset_at', 'reset_passed',
  'just_now', 'ago', 'checked',
  'note_no_permission', 'note_last_ok', 'note_stale', 'note_partial',
  'note_login', 'note_unread', 'badge_none',
  'wd_Sun', 'wd_Mon', 'wd_Tue', 'wd_Wed', 'wd_Thu', 'wd_Fri', 'wd_Sat',
  'reset_date_fmt', 'badge_pct', 'badge_sep', 'badge_note_fmt', 'account_n',
];

// One chrome.i18n message (used for the popup's own chrome, outside view.js).
export const msg = (key, subs) => chrome.i18n.getMessage(key, subs);

// Duration spacing is decided here, not in the catalog: an empty message risks
// a locale failing to load, so composeDur gets its separators from the UI
// locale instead. It joins "{count}{durNumSep}{unit}" with durPartSep — Spanish
// spaces number and unit ("2 h 48 min"), Japanese and Chinese run them together
// ("2時間48分"), everything else keeps "2h 48m" (ko "2시간 48분").
export function separatorsFor(locale = '') {
  const lang = String(locale).toLowerCase();
  if (lang.startsWith('es')) return {durNumSep: ' ', durPartSep: ' '};
  if (lang.startsWith('ja') || lang.startsWith('zh')) return {durNumSep: '', durPartSep: ''};
  return {durNumSep: '', durPartSep: ' '};
}

// The labels map for view.js, in the current UI locale.
export function viewLabels() {
  const labels = {};
  for (const key of VIEW_LABEL_KEYS) labels[key] = chrome.i18n.getMessage(key);
  Object.assign(labels, separatorsFor(chrome.i18n.getUILanguage()));
  return labels;
}
