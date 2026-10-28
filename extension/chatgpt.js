(() => {
  // A copy injected before the extension was reloaded or updated stays in the
  // page, deaf: its chrome.runtime is gone. Only a copy listening on this
  // extension's runtime counts as already running.
  const previous = window.__llmUsageOverlayChatGPT;
  try { if (typeof previous === 'function' && chrome.runtime.onMessage.hasListener(previous)) return; }
  catch (_) {}
  const PROVIDER = 'chatgpt';
  const FIVE_RE = /(?:5\s*시간\s*한도|5\s*[-–—]?\s*hour(?:s)?(?:\s+limit)?)/i;
  const WEEK_RE = /(?:주간\s*한도|weekly\s+limit|week(?:ly)?\s+limit)/i;
  const PCT_RE = /(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:remaining|left|남음|잔여)/i;
  const PCT_REVERSE_RE = /(?:remaining|left|남음|잔여)\D{0,24}(\d{1,3}(?:[.,]\d+)?)\s*%/i;
  // The two limits' titles, stricter than FIVE_RE ("resets in 5 hours" is not
  // a title). An element holding the other limit's title is past this limit's
  // card: its % may be the other limit's (CLAUDE.md §1).
  const FIVE_TITLE_RE = /(?:5\s*시간\s*한도|5\s*[-–—]?\s*hours?\s+(?:usage\s+)?limit)/i;
  const WEEK_TITLE_RE = /(?:주간\s*한도|week(?:ly)?\s+(?:usage\s+)?limit)/i;

  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const clamp = value => Math.max(0, Math.min(100, Number(value)));
  const short = (value, length = 240) => clean(value).slice(0, length);

  function visibleText(element) {
    if (!element) return '';
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
    return clean(element.innerText || element.textContent || '');
  }

  function percentage(text) {
    const normalized = clean(text).replace(/(\d),(\d)/g, '$1.$2');
    const match = normalized.match(PCT_RE) || normalized.match(PCT_REVERSE_RE);
    return match ? clamp(match[1]) : null;
  }

  function resetText(text) {
    const value = clean(text);
    const ko = value.match(/((?:\d+\s*일\s*)?(?:\d+\s*시간\s*)?(?:\d+\s*분\s*)?)후\s*초기화/i);
    if (ko && clean(ko[1])) return `${clean(ko[1])} 후 초기화`;
    const en = value.match(/(?:resets?|resetting)\s+(?:in\s+|on\s+|at\s+)?(.{1,70}?)(?=\s+\d{1,3}(?:[.,]\d+)?\s*%|$)/i);
    return en ? `resets ${clean(en[1])}` : '';
  }

  function markerElements(marker) {
    const all = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div,section,article,li,dt,dd');
    return [...all].filter(element => {
      const own = visibleText(element);
      if (!own || own.length > 100 || !marker.test(own)) return false;
      return ![...element.children].some(child => marker.test(visibleText(child)));
    });
  }

  function cardCandidates(markerElement, otherTitle) {
    const result = [];
    let node = markerElement;
    for (let depth = 0; node && node !== document.body && depth < 7; depth += 1, node = node.parentElement) {
      const text = visibleText(node);
      if (otherTitle.test(text)) break;
      if (text && text.length <= 1600) result.push({text, depth});
    }
    const parent = markerElement.parentElement;
    if (parent) {
      for (const sibling of parent.children) {
        const text = visibleText(sibling);
        if (text && text.length <= 1000 && !otherTitle.test(text)) result.push({text, depth:8});
      }
    }
    return result;
  }

  function findLimit(marker, otherTitle, title = marker) {
    // A title comes first, so "resets in 5 hours" on the weekly card is not
    // taken for the 5-hour limit while the page has a 5-hour title.
    const titles = markerElements(title);
    const markers = titles.length ? titles : markerElements(marker);
    const attempts = [];
    for (const markerElement of markers) {
      for (const candidate of cardCandidates(markerElement, otherTitle)) {
        const remaining = percentage(candidate.text);
        attempts.push(short(candidate.text, 180));
        if (remaining !== null) {
          return {found:true, remaining, reset:resetText(candidate.text), context:short(candidate.text), markerCount:markers.length};
        }
      }
    }
    return {found:markers.length > 0, remaining:null, reset:'', context:attempts.find(Boolean) || '', markerCount:markers.length};
  }

  function limitedUsageSnippets() {
    const snippets = [];
    for (const element of document.querySelectorAll('h1,h2,h3,h4,p,span,div')) {
      const text = visibleText(element);
      if (!text || text.length > 260) continue;
      if (FIVE_RE.test(text) || WEEK_RE.test(text) || PCT_RE.test(text) || /(?:초기화|resets?)/i.test(text)) {
        if (!snippets.includes(text)) snippets.push(text);
      }
      if (snippets.length >= 8) break;
    }
    return snippets.map(value => short(value, 180));
  }

  function scan() {
    const fiveHour = findLimit(FIVE_RE, WEEK_TITLE_RE, FIVE_TITLE_RE);
    const weekly = findLimit(WEEK_RE, FIVE_TITLE_RE);
    const snippets = limitedUsageSnippets();
    const routeDetected = /(?:^|[#/?])settings(?:\/|%2F)?usage/i.test(location.href) ||
      /(?:사용량|usage)/i.test(document.querySelector('[role="dialog"]')?.innerText || '');
    const percentages = [...new Set(snippets.flatMap(text =>
      [...text.matchAll(/\d{1,3}(?:[.,]\d+)?\s*%\s*(?:remaining|left|남음|잔여)/gi)].map(match => clean(match[0]))
    ))].slice(0, 8);
    const resets = [...new Set(snippets.map(resetText).filter(Boolean))].slice(0, 4);
    const selected = fiveHour.remaining !== null ? fiveHour.remaining : null;
    let failedStep = '';
    if (!routeDetected) failedStep = 'Settings > Usage route/dialog was not detected';
    else if (!fiveHour.found) failedStep = '5-hour limit label was not found';
    else if (fiveHour.remaining === null) failedStep = '5-hour card found, but its remaining percentage was not found';

    const debug = {
      at:Date.now(), url:location.href, routeDetected,
      fiveHourLabelFound:fiveHour.found, weeklyLabelFound:weekly.found,
      percentages, resets,
      selected:selected === null ? '?' : `${Math.round(selected)}%`,
      failedStep:failedStep || 'none',
      fiveHourContext:fiveHour.context,
      weeklyContext:weekly.context,
      snippets
    };
    // Normalized fields — additive. Existing `value`/`detail` above stay
    // byte-identical so the Python overlay on main keeps working.
    const limits = [];
    if (fiveHour.remaining !== null) limits.push({
      id:'chatgpt_5h', label:'5-hour limit',
      remaining_percent: Math.round(fiveHour.remaining),
      resets_at: null,
      reset_text: fiveHour.reset || null,
    });
    if (weekly.remaining !== null) limits.push({
      id:'chatgpt_weekly', label:'Weekly limit',
      remaining_percent: Math.round(weekly.remaining),
      resets_at: null,
      reset_text: weekly.reset || null,
    });
    if (selected === null) {
      return {payload:{provider:PROVIDER, value:'?', detail:failedStep || 'ChatGPT Usage data was not found.', status:'parse_failed', limits}, debug};
    }
    const detail = [`5-hour limit: ${Math.round(fiveHour.remaining)}% remaining`];
    if (fiveHour.reset) detail.push(fiveHour.reset);
    if (weekly.remaining !== null) detail.push(`weekly limit: ${Math.round(weekly.remaining)}% remaining`);
    if (weekly.reset) detail.push(weekly.reset);
    return {payload:{provider:PROVIDER, value:`${Math.round(selected)}%`, detail:detail.join(' · '), status:'ok', limits}, debug};
  }

  // Answers background only. It no longer reports on its own (on load or tab
  // focus): the API path is primary, and a page result must not overwrite it
  // (CLAUDE.md §2).
  const onMessage = (message, _sender, sendResponse) => {
    if (message?.type === 'SCAN_USAGE' || message?.type === 'DEBUG_CHATGPT') {
      sendResponse({ok:true, ...scan()});
    }
  };
  window.__llmUsageOverlayChatGPT = onMessage;
  chrome.runtime.onMessage.addListener(onMessage);
})();
