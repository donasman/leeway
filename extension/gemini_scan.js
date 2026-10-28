(() => {
  // Content script for an already-open gemini.google.com/usage tab. Like
  // chatgpt.js, it is injected by background (never statically registered),
  // answers background only (no self-reporting), and reads only the usage
  // screen — never conversation tabs (CLAUDE.md §3). It pulls the raw text of
  // the two usage cards from the live DOM; the pure module gemini.js (in the
  // service worker) turns that text into numbers and times (CLAUDE.md §2).
  //
  // Cards are found by their LABEL TEXT ("현재 사용량", "주간 한도"), not by
  // class: the page's class names are hashed and change between releases
  // (2026-10-15). From a label, it walks up to the nearest "N% 사용됨" and
  // "…에 초기화", stopping if the other card's label comes into view so it never
  // borrows the other card's numbers (the bug chatgpt.js still has, §0).

  // A copy injected before the extension was reloaded or updated stays in the
  // page, deaf: its chrome.runtime is gone. Only a copy listening on this
  // extension's runtime counts as already running (mirrors chatgpt.js).
  const previous = window.__llmUsageOverlayGemini;
  try { if (typeof previous === 'function' && chrome.runtime.onMessage.hasListener(previous)) return; }
  catch (_) {}

  const LABEL = {current: /^\s*(?:현재 사용량|Current usage)\s*$/i, weekly: /^\s*(?:주간 한도|Weekly limit)\s*$/i};
  const MENTION = {current: /현재 사용량|Current usage/i, weekly: /주간 한도|Weekly limit/i};
  const USED = /(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:사용됨|used)/i;
  const RESET = /(?:\d{1,2}월\s*\d{1,2}일\s*)?(?:오전|오후)\s*\d{1,2}:\d{2}\s*에\s*초기화/;
  // How old the page's numbers are (gemini.js updatedAgoMs). English: a guess.
  const UPDATED = /(?:방금|\d+\s*(?:분|시간|일)\s*전에)\s*업데이트됨|updated\s+(?:just\s+now|\d+\s*(?:min(?:ute)?|hour|day)s?\s+ago)/i;
  // How long to wait for the cards to render. A seam for tests only; never set
  // in the extension, so it stays 10s there.
  const TIMEOUT_MS = Number(globalThis.__llmGeminiScanTimeoutMs) || 10000;

  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visibleText = element => {
    if (!element) return '';
    try {
      const style = getComputedStyle(element);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return '';
    } catch (_) {}
    return clean(element.innerText || element.textContent || '');
  };

  // One card's {used, reset} raw strings, or null when the label isn't on the
  // page (or the matched label has no usage text near it — e.g. a conversation
  // in the sidebar titled like a card). `used` is null when the card is there
  // but its "% 사용됨" couldn't be read.
  const card = (key, other) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let first = null;
    while (walker.nextNode()) {
      if (!LABEL[key].test(walker.currentNode.textContent)) continue;
      let used = null, reset = null;
      for (let el = walker.currentNode.parentElement; el && el !== document.body && !(used && reset); el = el.parentElement) {
        const text = visibleText(el);
        if (MENTION[other].test(text)) break;
        used ??= text.match(USED)?.[0] ?? null;
        reset ??= text.match(RESET)?.[0] ?? null;
      }
      if (used) return {used, reset};
      if (reset) first ??= {used, reset};
    }
    return first;
  };
  const read = () => ({current: card('current', 'weekly'), weekly: card('weekly', 'current')});
  const complete = r => !!(r.current && r.current.used && r.current.reset && r.weekly && r.weekly.used && r.weekly.reset);

  // Read now; if the cards aren't fully rendered yet, re-read on each DOM change
  // (coalesced to every 250ms) until both are complete or TIMEOUT_MS passes.
  function readWhenReady() {
    const immediate = read();
    if (complete(immediate)) return Promise.resolve(immediate);
    return new Promise(resolve => {
      let pending = false;
      const finish = result => { observer.disconnect(); clearTimeout(timer); resolve(result); };
      const observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; const r = read(); if (complete(r)) finish(r); }, 250);
      });
      const timer = setTimeout(() => finish(read()), TIMEOUT_MS);
      observer.observe(document.body, {childList: true, subtree: true, characterData: true});
    });
  }

  async function scan() {
    const started = Date.now();
    const result = await readWhenReady();
    const cards = {current: result.current, weekly: result.weekly};
    const updated = (visibleText(document.body).match(UPDATED) || [null])[0];
    let failedStep = 'none';
    if (!cards.current) failedStep = cards.weekly ? 'current-usage card not found' : 'usage cards not found';
    else if (!cards.current.used) failedStep = 'current-usage card found, but no "% 사용됨"';
    // Diagnostics for the popup. Only usage strings are kept (the %/reset/updated
    // wording) — never other page text or conversation titles (CLAUDE.md §3).
    const debug = {
      at: Date.now(),
      url: location.origin + location.pathname,
      currentFound: !!cards.current,
      weeklyFound: !!cards.weekly,
      current: cards.current,
      weekly: cards.weekly,
      updated,
      waitedMs: Date.now() - started,
      failedStep,
    };
    return {cards, updated, debug};
  }

  // Answers background only — the service worker asks, reads the cards with
  // gemini.js, and decides what to store. Keeps the channel open for the async
  // (render-wait) reply by returning true.
  const onMessage = (message, _sender, sendResponse) => {
    if (message?.type === 'SCAN_GEMINI' || message?.type === 'DEBUG_GEMINI') {
      scan().then(result => sendResponse({ok: true, ...result})).catch(error => sendResponse({ok: false, error: error?.name || 'error'}));
      return true;
    }
  };
  window.__llmUsageOverlayGemini = onMessage;
  chrome.runtime.onMessage.addListener(onMessage);
})();
