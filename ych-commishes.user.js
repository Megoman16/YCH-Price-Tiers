// ==UserScript==
// @name         YCH.Commishes Price Sorter + Tier Chips
// @namespace    https://ych.commishes.com/
// @version      5.17
// @description  Price sort (loads ALL listings first), a "Sort by true cost" toggle, and price-tier chips (grouped by section, with a true-cost chip) inside each card
// @match        https://ych.commishes.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.__ychCommishesLoaded) return; // never run twice on the same page
  window.__ychCommishesLoaded = true;

  // ================= Config =================
  const STORE_KEY = 'ych-price-sort-mode';
  const TIERS_ON_KEY = 'ych-tiers-on';
  const SORT_KEY = 'ych-truecost-sort-on';
  const TIERS_CACHE_KEY = 'ych-tiers-cache-v9';
  try { localStorage.removeItem('ych-tiers-cache-v7'); localStorage.removeItem('ych-tiers-cache-v8'); } catch (e) {} // old cache read these listings without their tiers
  const VAL_ASC = '__price_asc';
  const VAL_DESC = '__price_desc';
  const MAX_SCROLL_ROUNDS = 200;
  const MAX_PAGES = 60;
  const SCROLL_DELAY = 800;
  const STABLE_ROUNDS_TO_STOP = 3;
  const TIER_CONCURRENCY = 2;       // simultaneous description fetches
  const TIER_GAP_MS = 400;          // pause between fetches
  const TIER_CACHE_DAYS = 7;        // fallback when an auction's end time can't be read
  const MAX_CACHE_DAYS = 14;        // never keep an entry longer than this, even if the auction runs longer
  const TIER_CACHE_MAX = 1500;
  const CACHE_SAVE_DELAY = 5000;
  const MAX_CHIPS = 30;
  const MAX_ROWS = 4;               // most chip rows to try per card when the card can't grow
  const MAX_ROWS_TALL = 14;         // most chip rows when the card is allowed to grow

  let mode = 'default';
  try { mode = localStorage.getItem(STORE_KEY) || 'default'; } catch (e) {}
  let tiersOn = true;
  try { tiersOn = (localStorage.getItem(TIERS_ON_KEY) || '1') === '1'; } catch (e) {}
  let sortOn = false;
  try { sortOn = localStorage.getItem(SORT_KEY) === '1'; } catch (e) {}

  let applying = false;
  let loading = false;
  let cancelled = false;
  let origCounter = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ================= Page detection =================
  function findSortSelect() {
    return Array.from(document.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => /ending soon|newest first/i.test(o.textContent))
    );
  }
  function isListingUrl() {
    const p = location.pathname;
    if (/^\/(auction|account|home|user|settings)\//.test(p)) return false;
    return p === '/' || /^\/category\//.test(p);
  }
  function isListingPage() { return !!findSortSelect() || isListingUrl(); }

  // ================= Card helpers =================
  function cardFromLink(a) {
    let el = a;
    while (el.parentElement && el.parentElement.children.length === 1) el = el.parentElement;
    return el;
  }

  function getCards(root) {
    root = root || document;
    const cards = [];
    const seen = new Set();
    root.querySelectorAll('a[href*="/auction/show/"]').forEach((a) => {
      if (a.closest && a.closest('.ych-tiers')) return;
      const el = cardFromLink(a);
      if (seen.has(el)) return;
      seen.add(el);
      if (root === document && el.dataset.ychOrig === undefined) el.dataset.ychOrig = String(origCounter++);
      cards.push(el);
    });
    return cards;
  }

  function cardHref(card) {
    const a = card.matches && card.matches('a[href*="/auction/show/"]')
      ? card : card.querySelector('a[href*="/auction/show/"]');
    return a ? a.getAttribute('href') : null;
  }

  function auctionId(href) {
    const m = (href || '').match(/\/auction\/show\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  // The element that shows the current price (a text node like "$25.00").
  function findPriceEl(card) {
    const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (n.parentElement && n.parentElement.closest('.ych-tiers')) continue;
      if (/^\s*\$\s?\d[\d,]*(\.\d+)?\s*$/.test(n.textContent)) return n.parentElement;
    }
    return null;
  }

  function getPrice(card) {
    const pe = findPriceEl(card);
    const src = pe ? pe.textContent : (card.textContent || '');
    const m = src.match(/\$\s?([\d,]+(?:\.\d+)?)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }

  // ================= Sorting =================
  // Order of precedence: "Sort by true cost" (if on), else the dropdown's price mode, else the original order.
  const costKey = (c) => c._ychCost === undefined ? 1e10 : (c._ychCost === null ? 1e9 : c._ychCost);

  function applySort() {
    applying = true;
    try {
      const groups = new Map();
      getCards().forEach((c) => {
        const p = c.parentElement;
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(c);
      });
      groups.forEach((items, parent) => {
        if (items.length < 2) return;
        const withPrice = items.map((c) => ({ c, p: (sortOn || mode === 'default') ? 0 : getPrice(c) }));
        withPrice.sort((a, b) => {
          if (sortOn) return costKey(a.c) - costKey(b.c); // stable: ties keep their current order
          if (mode === 'default') return Number(a.c.dataset.ychOrig) - Number(b.c.dataset.ychOrig);
          if (a.p === null && b.p === null) return 0;
          if (a.p === null) return 1;
          if (b.p === null) return -1;
          return mode === 'asc' ? a.p - b.p : b.p - a.p;
        });
        const sorted = withPrice.map((x) => x.c);
        if (sorted.every((el, i) => el === items[i])) return;
        const before = items[0].previousSibling;
        const frag = document.createDocumentFragment();
        sorted.forEach((el) => frag.appendChild(el));
        parent.insertBefore(frag, before ? before.nextSibling : parent.firstChild);
      });
    } finally {
      setTimeout(() => { applying = false; }, 100);
    }
  }

  // While tiers are still being read, re-sort at most every ~1.2s so cards don't jump constantly.
  let sortTimer = null;
  function scheduleSort() {
    if (!sortOn) return;
    clearTimeout(sortTimer);
    sortTimer = setTimeout(applySort, 1200);
  }

  // ================= Toast =================
  let toast = null;
  function showToast(text, withStop) {
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:10px;background:rgba(30,30,30,.94);color:#fff;font:13px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      toast.innerHTML = '<span class="ych-msg"></span><button style="cursor:pointer;border:0;border-radius:6px;padding:5px 9px;background:#c0392b;color:#fff;font:inherit">Stop</button>';
      toast.querySelector('button').onclick = () => { cancelled = true; };
      document.body.appendChild(toast);
    }
    toast.querySelector('.ych-msg').textContent = text;
    toast.querySelector('button').style.display = withStop ? '' : 'none';
    toast.style.display = 'flex';
  }
  function hideToast(delay) { setTimeout(() => { if (toast) toast.style.display = 'none'; }, delay || 0); }

  // ================= Load everything =================
  function findLoadMoreButton() {
    return Array.from(document.querySelectorAll('button, a, [role="button"]')).find((el) => {
      if (el.offsetParent === null) return false;
      const t = (el.textContent || '').trim();
      return /^(load|show|see|view)\s+more\b/i.test(t) || /^more$/i.test(t);
    });
  }

  function findNextUrl(doc, baseUrl) {
    let href = null;
    const rel = doc.querySelector('a[rel~="next"], link[rel~="next"]');
    if (rel) href = rel.getAttribute('href');
    if (!href) {
      const a = Array.from(doc.querySelectorAll('a[href]')).find((x) => {
        const t = (x.textContent || '').trim();
        return /^(next|next page|›|»|>|→)$/i.test(t) || /next/i.test(x.getAttribute('aria-label') || '');
      });
      if (a) href = a.getAttribute('href');
    }
    if (!href || href === '#' || href.startsWith('javascript:')) return null;
    try { return new URL(href, baseUrl).href; } catch (e) { return null; }
  }

  async function scrollLoad() {
    let last = getCards().length;
    let stable = 0;
    for (let i = 0; i < MAX_SCROLL_ROUNDS && !cancelled; i++) {
      const btn = findLoadMoreButton();
      if (btn) btn.click();
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(SCROLL_DELAY / 2);
      window.scrollBy(0, -400);
      await sleep(100);
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(SCROLL_DELAY / 2);
      const count = getCards().length;
      showToast('Loading all listings… ' + count + ' found', true);
      if (count === last && !btn) { if (++stable >= STABLE_ROUNDS_TO_STOP) break; }
      else { stable = 0; last = count; }
    }
  }

  async function pageLoad() {
    const existing = new Set(getCards().map(cardHref));
    let url = findNextUrl(document, location.href);
    let pages = 0;
    while (url && pages < MAX_PAGES && !cancelled) {
      pages++;
      showToast('Loading page ' + (pages + 1) + '… ' + existing.size + ' found', true);
      let doc;
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      } catch (e) { break; }
      const newCards = getCards(doc).filter((c) => {
        const h = cardHref(c);
        if (!h || existing.has(h)) return false;
        existing.add(h);
        return true;
      });
      if (!newCards.length) break;
      const live = getCards();
      const last = live[live.length - 1];
      if (!last) break;
      let ref = last;
      newCards.forEach((c) => {
        const node = document.importNode(c, true);
        ref.parentElement.insertBefore(node, ref.nextSibling);
        ref = node;
      });
      url = findNextUrl(doc, url);
      await sleep(400);
    }
  }

  async function loadAll() {
    if (loading) return;
    loading = true;
    cancelled = false;
    try {
      showToast('Loading all listings…', true);
      await scrollLoad();
      if (!cancelled) await pageLoad();
    } finally {
      loading = false;
      const n = getCards().length;
      showToast(cancelled ? 'Stopped at ' + n + ' listings' : 'Loaded ' + n + ' listings', false);
      hideToast(2500);
      refreshTierObservers();
    }
  }

  async function setMode(newMode) {
    mode = newMode;
    try { localStorage.setItem(STORE_KEY, mode); } catch (e) {}
    if (mode === 'default') { cancelled = true; applySort(); return; }
    await loadAll();
    if (mode === newMode) { applySort(); window.scrollTo(0, 0); }
  }

  // ================= Tier parsing =================
  // groups: 1 = leading "+" (add-on), 2/3 = amount, 4 = trailing "+"
  const AMOUNT_RE = /([+＋]\s*)?(?:[≥>≤<]\s*)?(?:[$€£]\s?(\d{1,5}(?:\.\d{1,2})?)|(\d{1,5}(?:\.\d{1,2})?)\s?(?:[$€£]|usd\b|eur\b|dollars?\b|bucks\b))(\s?\+)?/gi;
  const SKIP_LINE_RE = /payments?\b|paypal|ko-?fi|refund|deposit|autobuy|auto-?buy|ready before|deadline/i;

  function cleanLabel(s) {
    s = s.replace(/[✦✧★☆◆◇❖✿❀▪►▶\uFE0E\uFE0F]/g, ' ') // decorative bullets
         .replace(/\s{2,}/g, ' ')
         .replace(/([:=])\s*[-–—]+/g, '$1')
         .replace(/\s*[-–—:=]+\s*(?=[(\[])/, ' ')
         .replace(/\*+/g, '')
         .replace(/^[\s\-–—:=~>≥≤+*•.,/]+|[\s\-–—:=~>≥≤+*•.,/]+$/g, '')
         .trim();
    return s.length > 40 ? s.slice(0, 39).trimEnd() + '…' : s;
  }

  // A line with no price that looks like a section title: "BUST:", "Half-body", "ICONS"
  function headerOf(line) {
    const t = line.replace(/[*_~#]+/g, '').trim();
    if (!t) return null;
    const letters = t.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) return null;
    const colon = /[:：]\s*$/.test(t);
    // a sentence ending in ":" isn't a heading: at most 6 real words (symbols like ✧ don't count); the script's own
    // "Linked - …:" / "Auction - …:" headings always count
    const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
    if ((colon && (/^(?:Linked|Auction) - /.test(t) || (t.length <= 60 && words <= 6))) || (letters.length >= 4 && t === t.toUpperCase() && t.length <= 40)) {
      return t.replace(/[\s:：\-–—=~]+$/g, '').replace(/^[^\p{L}\p{N}]+/u, '').trim() || null;
    }
    return null;
  }

  // Ranges: "$1-$10", "$1 to $10", "1 to 10 Dollars"
  const RANGE_RES = [
    /[$€£]\s?(\d{1,5}(?:\.\d{1,2})?)\s*(?:to|[-–—])\s*[$€£]?\s?(\d{1,5}(?:\.\d{1,2})?)/i,
    /(\d{1,5}(?:\.\d{1,2})?)\s*(?:to|[-–—])\s*(\d{1,5}(?:\.\d{1,2})?)\s*(?:[$€£]|dollars?\b|usd\b|eur\b|bucks\b)/i
  ];
  function findRange(seg) {
    for (const re of RANGE_RES) {
      const m = seg.match(re);
      if (!m) continue;
      if (/\s-\S/.test(m[0]) && !/\s-\s/.test(m[0])) continue; // "$3 -$11" is two prices, not a range
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (lo > 0 && hi > lo && hi <= 5000) return { m: m, lo: lo, hi: hi };
    }
    return null;
  }

  // Tiers marked AB / absolute bid / auto-buy / buy now with NO description of their own ("$10 AB", "$60 Auto Buy: USD")
  // are shown but never count toward "true cost". An AB tier that describes something ("AB: $17 full color") does count.
  // Currency words (USD, dollars...) are not a description.
  // "AB", "AB1", "AB 2", "AB#3", "A.B.", "absolute bid", "auto buy", "buy now", "buyout"
  const AB_WORD = '(?:(?:AB|A\\.B\\.)\\s?#?\\d{0,2}|absolute\\s*bid|auto-?\\s?buy|buy\\s?now|buyout)';
  const AB_BEFORE_RE = new RegExp('\\b' + AB_WORD + '\\s*[:=\\-–—(]*\\s*$', 'i');
  const AB_AFTER_RE = new RegExp('^[\\s)\\]]*[:=\\-–—]*\\s*' + AB_WORD + '(?![A-Za-z])', 'i');
  const isAbAt = (seg, start, end) =>
    AB_BEFORE_RE.test(seg.slice(Math.max(0, start - 20), start)) || AB_AFTER_RE.test(seg.slice(end, end + 20));

  const AB_WORD_G = new RegExp('\\b' + AB_WORD + '(?![A-Za-z])', 'gi');
  const CUR_WORD_G = /\b(?:usd|eur|gbp|cad|aud|dollars?|bucks?)\b/gi;
  const hasInfo = (label) => label.replace(AB_WORD_G, ' ').replace(CUR_WORD_G, ' ').replace(/[^A-Za-z]/g, '').length >= 2;

  // true: an AB tier that describes something ("AB: $17 full color") still counts toward true cost.
  // false: every AB / AB1 / AB2 tier is left out of true cost.
  const AB_DESCRIBED_COUNTS = true;

  // Lines that describe a surcharge / extra rather than a tier ("...the surcharge will be $8",
  // "Added +1 custom emoji + 10$ (2 characters 20$)"): every price on them is an add-on.
  const ADD_LINE_RE = /\b(?:surcharge|up-?charge|add-?ons?|additional|added|extra\s+(?:charge|fee|cost)|fees?|rush)\b|\badd\s+(?:a|an|another|one)\b|\bM\.?B\.?(?![A-Za-z])|\b(?:min(?:imum)?\s*)?(?:bid\s*)?increment\b/i;

  function tiersFromSegment(seg, section, out) {
    const addLine = ADD_LINE_RE.test(seg);
    const rg = findRange(seg);
    if (rg) {
      const rest = seg.replace(rg.m[0], ' ');
      const plus = /^\s?\+/.test(seg.slice(seg.indexOf(rg.m[0]) + rg.m[0].length));
      const at = seg.indexOf(rg.m[0]);
      const rlabel = cleanLabel(rest);
      const ab = isAbAt(seg, at, at + rg.m[0].length) && (!hasInfo(rlabel) || !AB_DESCRIBED_COUNTS);
      out.push({ p: rg.lo, hi: rg.hi, plus: plus, add: addLine, ab: ab, label: rlabel, section: section, line: seg.trim() });
      return;
    }
    const matches = Array.from(seg.matchAll(AMOUNT_RE));
    if (!matches.length) return;
    let label = seg;
    matches.forEach((m) => { label = label.replace(m[0], ' '); });
    label = cleanLabel(label);
    // With several prices on one line the label is shared, so it can't vouch for one of them: only a lone price can
    // be rescued from the AB exclusion by its own description.
    const solo = matches.length === 1;
    matches.forEach((m) => {
      const p = parseFloat(m[2] || m[3]);
      if (!p || p > 5000) return;
      const ab = isAbAt(seg, m.index, m.index + m[0].length) && (!solo || !hasInfo(label) || !AB_DESCRIBED_COUNTS);
      out.push({ p: p, plus: !!m[4], add: !!m[1] || addLine, ab: ab, label: label, section: section, line: seg.trim() });
    });
  }

  const hasAmount = (l) => /[$€£]\s?\d|\d\s?(?:[$€£]|usd\b|eur\b|dollars?\b|bucks\b)/i.test(l);

  // "$15 ➜ $10": the price was lowered, so only the second (current) price counts.
  // Also turns fancy Unicode text (𝟏𝟓, 𝗦𝗸𝗲𝘁𝗰𝗵) into plain characters first.
  const PRICE_PART = '(?:[$€£]\\s?\\d{1,5}(?:\\.\\d{1,2})?|\\d{1,5}(?:\\.\\d{1,2})?\\s?[$€£])';
  const DROP_ARROW = '(?:➜|➔|➝|➞|➙|➛|➤|➡\\uFE0F?|→|⟶|⇒|⟹|-+>|=+>|>>|»)';
  const PRICE_DROP_RE = new RegExp(PRICE_PART + '\\s*' + DROP_ARROW + '\\s*(' + PRICE_PART + ')', 'g');
  // Small-caps letters ("ɪʟʟᴜsᴛʀᴀᴛɪᴏɴ 140 ᴜsᴅ") aren't touched by NFKC, so map them to plain letters.
  const SMALL_CAPS = { 'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j',
    'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u',
    'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z' };
  const SMALL_CAPS_RE = new RegExp('[' + Object.keys(SMALL_CAPS).join('') + ']', 'g');
  function normalizeText(text) {
    let t = (text || '').normalize('NFKC').replace(SMALL_CAPS_RE, (c) => SMALL_CAPS[c]);
    let prev;
    do { prev = t; t = t.replace(PRICE_DROP_RE, '$1'); } while (t !== prev); // handles "$20 ➜ $15 ➜ $10" too
    return t;
  }

  // Lines with a bare number and no currency sign: "20+: Sketch Colored", "• 35: Flat color".
  // Only trusted when at least two lines look like that, so a lone "Slot 2: ..." or a time isn't mistaken for a price.
  const BARE_RE = /^[^\p{L}\p{N}$€£]*?(\d{1,4}(?:\.\d{1,2})?)\s*(?:(\+)\s*[:：=\-–—]?|[:：=])\s*(?=[^\d\s])(.+)$/u;
  function bareGoalLines(lines) {
    const hits = lines.filter((l) => BARE_RE.test(l)).length;
    if (hits < 2) return lines;
    return lines.map((l) => {
      const m = l.match(BARE_RE);
      return m ? '$' + m[1] + (m[2] || '') + ' ' + m[3] : l;
    });
  }

  // "SB: 1 - flat color", "AB: 15 - shaded", "Min bid = 5": a price keyword, then a bare number with no
  // currency sign. The keyword already says it's a price, so a single line like this is trusted.
  const KEYWORD_BARE_RE = /^([^\p{L}\p{N}]*(?:S\.?B\.?|A\.?B\.?|M\.?B\.?|start(?:ing)?(?:\s*bid)?|min(?:imum)?(?:\s*bid)?|absolute\s*bid|auto-?\s?buy|buy\s?now|buyout|price)#?\d{0,2})(?![A-Za-z])(?:\s*[:：=\-–—]\s*|\s+)(\d{1,4}(?:\.\d{1,2})?)\s*(\+)?(?:\s*[:：=\-–—]?\s*(?![\d$€£])(.*))?$/iu;
  function keywordBareLines(lines) {
    return lines.map((l) => {
      if (hasAmount(l)) return l;
      const m = l.match(KEYWORD_BARE_RE);
      if (!m) return l;
      return m[1].trim() + ': $' + m[2] + (m[3] || '') + (m[4] ? ' ' + m[4] : '');
    });
  }

  // "AB $16" on one line and "AB full render" on another: the same price, described further down.
  // Joins them into one tier ("AB $16 full render"), so the AB price counts toward true cost.
  const KEY_CODE = '(?:[SAM]\\.?\\s?B\\.?#?\\d{0,2}|absolute\\s*bid|buy\\s?now|buyout)';
  const KEY_PRICE_ONLY_RE = new RegExp('^[^\\p{L}\\p{N}$€£]*(' + KEY_CODE + ')(?![A-Za-z])\\s*[:：=\\-–—]?\\s*(' + PRICE_PART + '\\s*\\+?)\\s*$', 'iu');
  const KEY_DESC_RE = new RegExp('^[^\\p{L}\\p{N}$€£]*(' + KEY_CODE + ')(?![A-Za-z0-9])\\s*[:：=\\-–—]?\\s*(\\p{L}.*)$', 'iu');
  const keyNorm = (k) => k.toUpperCase().replace(/[\s.]/g, '');
  function mergeKeywordLines(lines) {
    const priceLines = new Map(); // key -> indexes of its price-only lines
    lines.forEach((l, i) => {
      const m = l.match(KEY_PRICE_ONLY_RE);
      if (!m) return;
      const k = keyNorm(m[1]);
      if (!priceLines.has(k)) priceLines.set(k, []);
      priceLines.get(k).push(i);
    });
    if (!priceLines.size) return lines;
    const drop = new Set();
    const res = lines.map((l, i) => {
      if (hasAmount(l)) return l;
      const m = l.match(KEY_DESC_RE);
      if (!m) return l;
      const list = (priceLines.get(keyNorm(m[1])) || []).filter((j) => !drop.has(j));
      if (!list.length) return l;
      // The closest one above (the same price can be listed twice, e.g. a post and its linked auction), else below
      const above = list.filter((j) => j < i);
      const at = above.length ? above[above.length - 1] : list[0];
      drop.add(at);
      return m[1] + ' ' + lines[at].match(KEY_PRICE_ONLY_RE)[2].trim() + ' ' + m[2];
    });
    return res.filter((l, i) => !drop.has(i));
  }


  // "Illustration" on one line and "140 USD" on the next: a price line with no words of its own takes the
  // line above as its name (unless that line is a section title like "BUST:").
  function joinLonePrices(lines) {
    const out = [];
    lines.forEach((l) => {
      const prev = out[out.length - 1];
      const words = l.replace(AMOUNT_RE, ' ').replace(CUR_WORD_G, ' ').replace(/[^\p{L}]/gu, '');
      // A price that's its own bullet point ("- $15") belongs to no line above it
      if (hasAmount(l) && words.length < 2 && !/^[-–—*•·✦►▶]\s/.test(l) && prev !== undefined && !hasAmount(prev) && prev.length <= 40 &&
          /\p{L}{2}/u.test(prev) && !headerOf(prev)) {
        out[out.length - 1] = prev.replace(/[\s:：\-–—=]+$/, '') + ': ' + l;
      } else out.push(l);
    });
    return out;
  }

  // A piece that mentions payment / deadline: keep what comes before those words if it has a price
  // ("$15 - Payments via PayPal" keeps "$15"), otherwise drop it.
  function beforeSkip(p) {
    if (!p || !SKIP_LINE_RE.test(p)) return p;
    const head = p.slice(0, p.search(SKIP_LINE_RE)).replace(/[\s\-–—:=(\/|]+$/, '').trim();
    return hasAmount(head) ? head : '';
  }

  function parseTiers(text) {
    text = normalizeText(text);
    // A payment / deadline line is dropped, but only the comma-separated part that mentions it:
    // "SB: $35, AB: 50, paypal - 1 slot only" keeps "SB: $35" and "AB: 50"; "$26 per slot. PayPal, USD" keeps "$26 per slot".
    // Splits at commas and at full stops followed by a space (so "$26.50" stays whole).
    let lines = text.split(/\n|\s{2,}|[|•;]/).map((l) => l.trim()).filter(Boolean)
      .flatMap((l) => SKIP_LINE_RE.test(l) ? l.split(/,\s*|\.\s+/).map((p) => p.trim()).map(beforeSkip).filter(Boolean) : [l]);
    lines = joinLonePrices(bareGoalLines(mergeKeywordLines(keywordBareLines(lines))));

    // Title lines with no colon: a price-less line followed by a "— item $5" style line.
    // Only trusted when it happens at least twice, so a lone listing title isn't mistaken for one.
    const cand = new Set();
    lines.forEach((l, i) => {
      const nx = lines[i + 1];
      if (!hasAmount(l) && l.length <= 60 && !headerOf(l) && nx && hasAmount(nx) && /^[—–-]/.test(nx)) cand.add(i);
    });
    const trust = cand.size >= 2;

    const out = [];
    let section = '';
    lines.forEach((line, i) => {
      if (!hasAmount(line)) {
        const h = headerOf(line) || (trust && cand.has(i) ? line.replace(/[*_~#]+/g, '').replace(/[\s:：]+$/, '').trim() : null);
        if (h) section = h;
        return;
      }
      const count = (line.match(AMOUNT_RE) || []).length;
      if (count >= 2 && !findRange(line)) line.split(/[\/,]/).forEach((piece) => tiersFromSegment(piece, section, out));
      else tiersFromSegment(line, section, out);
    });
    const seen = new Set();
    const own = new Set(); // prices from the post itself (not from a linked page / auction)
    const isLinked = (sec) => /^(?:Auction|Linked) - /.test(sec);
    const res = out.filter((t) => {
      const k = t.section + '|' + t.p + '|' + (t.hi || '') + '|' + t.add + '|' + t.ab + '|' + t.label;
      const k2 = t.p + '|' + (t.hi || '') + '|' + t.add + '|' + t.label.toLowerCase();
      if (seen.has(k)) return false;
      if (isLinked(t.section) && own.has(k2)) return false; // the auction repeats what the post already said
      seen.add(k);
      if (!isLinked(t.section)) own.add(k2);
      return true;
    });
    // Sectioned lists keep the author's order; flat lists sort by price (add-ons last)
    if (!res.some((t) => t.section)) res.sort((a, b) => (a.add - b.add) || (a.p - b.p));
    return res;
  }

  function nodeText(n) {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(n.tagName)) return '';
    const c = n.cloneNode(true);
    c.querySelectorAll('script,style').forEach((e) => e.remove());
    c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    c.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6').forEach((e) => e.append('\n'));
    return c.textContent + (/^(P|DIV|LI|UL|OL)$/.test(n.tagName) ? '\n' : '');
  }

  // Walks down the tree to the smallest element whose text contains `key`
  // (whitespace ignored, because <br> leaves no space behind). Much cheaper than testing every element.
  function smallestContaining(doc, key) {
    const squash = (t) => t.replace(/\s+/g, '');
    let el = doc.body;
    if (!el || !squash(el.textContent || '').includes(key)) return '';
    for (;;) {
      const next = Array.from(el.children).find((ch) =>
        !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(ch.tagName) && squash(ch.textContent || '').includes(key));
      if (!next) break;
      el = next;
    }
    return (el.textContent || '').length > 8000 ? '' : nodeText(el);
  }

  // Two ways to find the real description (the meta tag is truncated and has its line breaks flattened):
  //  A) the smallest element whose text contains the start of the meta summary
  //  B) everything after the page's <h1> up to the next heading
  // Whichever is at least as long as the meta text wins; otherwise the meta text itself is used.
  function extractDescription(doc) {
    const metaEl = doc.querySelector('meta[property="og:description"]') || doc.querySelector('meta[name="description"]');
    const meta = metaEl ? (metaEl.getAttribute('content') || '') : '';

    const key = meta.replace(/(\.{3}|…)\s*$/, '').replace(/\s+/g, '').slice(0, 60);
    const a = key.length >= 8 ? smallestContaining(doc, key) : '';

    let b = '';
    const h1 = doc.querySelector('h1');
    if (h1) {
      const parts = [];
      let n = h1.nextSibling;
      for (let g = 0; n && g < 50; g++, n = n.nextSibling) {
        if (n.nodeType === 1 && /^H[1-6]$/.test(n.tagName)) break;
        parts.push(nodeText(n));
      }
      b = parts.join('\n').split(/Samples\s+These are examples/i)[0];
    }

    if (a.length && a.length >= meta.length) return a;
    if (b.length && b.length >= meta.length) return b;
    return meta;
  }

  // "True cost": the higher of the most expensive tier (top of a range counts; add-ons and AB-only tiers don't)
  // and the current price. No tiers -> current price. null = no price info at all.
  function trueCost(tiers, price) {
    const tierMax = tiers.filter((t) => !t.add && !t.ab).reduce((m, t) => Math.max(m, t.hi || t.p), 0);
    const c = Math.max(tierMax, price || 0);
    return c > 0 ? c : null;
  }

  // ================= Tier cache =================
  let tierCache = {};
  try { tierCache = JSON.parse(localStorage.getItem(TIERS_CACHE_KEY) || '{}'); } catch (e) { tierCache = {}; }
  let saveTimer = null;
  let cacheDirty = false;
  // An entry is live until its auction ends (exp). Older entries without exp fall back to TIER_CACHE_DAYS.
  const isLive = (v, now) => !!v && (v.exp ? v.exp > now : v.t > now - TIER_CACHE_DAYS * 864e5);

  function writeCache() {
    clearTimeout(saveTimer);
    if (!cacheDirty) return;
    cacheDirty = false;
    const now = Date.now();
    let entries = Object.entries(tierCache).filter(([, v]) => isLive(v, now));
    entries.sort((a, b) => b[1].t - a[1].t); // newest first, so trimming drops the oldest
    if (entries.length > TIER_CACHE_MAX) entries = entries.slice(0, TIER_CACHE_MAX);
    // Storage full: drop the oldest quarter and try again, until it fits
    for (let attempt = 0; attempt < 12 && entries.length; attempt++) {
      try {
        tierCache = Object.fromEntries(entries);
        localStorage.setItem(TIERS_CACHE_KEY, JSON.stringify(tierCache));
        updateCacheCount();
        return;
      } catch (e) {
        entries = entries.slice(0, Math.floor(entries.length * 0.75));
      }
    }
    tierCache = Object.fromEntries(entries);
    updateCacheCount();
  }
  let cacheCountEl = null; // the Clear cache button, once it exists
  function updateCacheCount() {
    if (cacheCountEl) cacheCountEl.textContent = 'Clear cache (' + Object.keys(tierCache).length + ' saved)';
  }
  function saveCache() {
    cacheDirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeCache, CACHE_SAVE_DELAY);
  }
  // Save immediately when the tab is hidden or closed, so tiers read in the last few seconds aren't lost
  window.addEventListener('pagehide', writeCache);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeCache(); });

  // Each entry keeps the listing's description text (d), so when the tier reader gets smarter (PARSER_VERSION goes up)
  // saved listings are simply re-read from that text, with no request to the site and no cache reset.
  const PARSER_VERSION = 8;
  const DESC_KEEP = 3000; // characters of description kept per listing
  function cachedTiers(id) {
    const v = tierCache[id];
    if (!isLive(v, Date.now())) return null;
    if (v.pv !== PARSER_VERSION && typeof v.d === 'string') {
      v.tiers = parseTiers(v.d);
      v.pv = PARSER_VERSION;
      saveCache();
    }
    return v;
  }

  // ---- When does this auction end? Read the time-left text on its card. ----
  const UNIT_MS = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 };
  function parseTimeLeft(t) {
    // "7H 4M 38S left", "2D 9H", "13H 05M"
    let m = t.match(/^(?:(\d+)\s*D\s*)?(?:(\d+)\s*H\s*)?(?:(\d+)\s*M\s*)?(?:(\d+)\s*S\s*)?(left)?$/i);
    if (m && (m[1] || m[2] || m[3] || m[4])) {
      if (m[1] && !m[2] && !m[3] && !m[4] && !m[5]) return null; // a lone "3D" is probably part of a title
      return (+m[1] || 0) * 864e5 + (+m[2] || 0) * 36e5 + (+m[3] || 0) * 6e4 + (+m[4] || 0) * 1e3;
    }
    // "about 13 hours", "3 days", "less than a minute"
    m = t.match(/^(?:in\s+)?(?:(?:less than|about|over|almost|around)\s+)?(\d+|an?|one)\s+(second|minute|hour|day|week|month)s?(?:\s+(?:left|remaining))?$/i);
    if (m) return (/^\d+$/.test(m[1]) ? +m[1] : 1) * UNIT_MS[m[2].toLowerCase()];
    return null;
  }
  function timeLeftMs(card) {
    const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (n.parentElement && n.parentElement.closest('.ychart-tiers, .ych-tiers')) continue;
      const t = (n.textContent || '').trim();
      if (!t || t.length > 40) continue;
      const ms = parseTimeLeft(t);
      if (ms !== null) return ms;
    }
    return null;
  }
  // Cached tiers expire when the auction ends (never later than MAX_CACHE_DAYS; TIER_CACHE_DAYS if the time can't be read)
  function cacheExpiry(card) {
    const now = Date.now();
    const left = timeLeftMs(card);
    if (left === null) return now + TIER_CACHE_DAYS * 864e5;
    return Math.min(Math.max(now + left, now + 6e4), now + MAX_CACHE_DAYS * 864e5);
  }

  // ================= Tier rendering =================
  const style = document.createElement('style');
  style.textContent =
    '.ych-tiers{display:flex;flex-wrap:wrap;gap:4px;margin:3px 0;overflow:hidden;cursor:help;position:relative}' +
    '.ych-tiers.ych-clipped::after{content:"+ more";position:absolute;right:0;bottom:0;background:#fff;color:#14306e;font-size:11px;line-height:16px;font-weight:600;padding:1px 4px 1px 8px;box-shadow:-8px 0 6px #fff}' +
    '.ych-tier{flex:0 1 auto;min-width:0;max-width:100%;box-sizing:border-box;overflow:hidden;display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:1px 7px;border-radius:10px;background:#e8eefc;color:#1f2d4d;border:1px solid #c5d3f7;white-space:nowrap}' +
    '.ych-tier b{font-weight:700;color:#14306e}' +
    '.ych-tier.ych-add{background:#f0f0f0;border-color:#d4d4d4;color:#444}' +
    '.ych-tier.ych-add b{color:#333}' +
    '.ych-tier.ych-ab{background:#ece6fa;border-color:#cdbff0;color:#3b2a6b}' +
    '.ych-tier.ych-ab b{color:#3b2a6b}' +
    '.ych-tier.ych-cost{background:#fff1d6;border-color:#f0c36d;color:#6b4300}' +
    '.ych-tier.ych-cost b{color:#6b4300}' +
    '.ych-lbl{min-width:0;max-width:150px;overflow:hidden;text-overflow:ellipsis}' +
    '.ych-sec{flex:0 0 100%;box-sizing:border-box;height:20px;line-height:20px;padding:0 2px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#5b6784;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#ych-pop{position:fixed;z-index:2147483647;display:none;pointer-events:none;max-width:min(380px,92vw);box-sizing:border-box;background:#fff;color:#1c1c1c;border:1px solid #c9cfdd;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:6px 10px;font:12px/1.4 system-ui,sans-serif;text-align:left}' +
    '#ych-pop div{white-space:normal;overflow-wrap:anywhere;padding:3px 0}' +
    '#ych-pop div+div{border-top:1px solid #eceff5}' +
    '.ych-tiers-off .ych-tiers{display:none!important}';
  document.head.appendChild(style);
  document.documentElement.classList.toggle('ych-tiers-off', !tiersOn);

  function fmtPrice(p) { return '$' + (Number.isInteger(p) ? p : p.toFixed(2)); }

  // Floating panel that shows every full tier line, wrapped, on hover.
  let pop = null;
  function getPop() {
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'ych-pop';
      document.body.appendChild(pop);
      window.addEventListener('scroll', hidePop, { passive: true });
    }
    return pop;
  }
  function showPop(box) {
    const lines = box._lines || [];
    if (!lines.length) return;
    const el = getPop();
    el.textContent = '';
    lines.forEach((l) => { const d = document.createElement('div'); d.textContent = l; el.appendChild(d); });
    el.style.display = 'block';
    const r = box.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = r.top - h - 4;
    if (top < 8) top = 8;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  function hidePop() { if (pop) pop.style.display = 'none'; }

  // ---- Fit as many chip rows as the card can hold without breaking its layout ----
  function findArtRect(card) {
    let best = null, bestArea = 0;
    card.querySelectorAll('img').forEach((im) => {
      const r = im.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = r; }
    });
    if (bestArea >= 15000) return best;
    card.querySelectorAll('div, a, span').forEach((el) => {
      if (el.closest('.ych-tiers')) return;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a <= bestArea || a < 15000) return;
      if (getComputedStyle(el).backgroundImage !== 'none') { bestArea = a; best = r; }
    });
    return best;
  }

  function hasOverlap(box, card, art) {
    const cr = card.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    if (br.bottom > cr.bottom + 1) return true; // chips spill out of the card
    if (!art) return false;
    const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let n;
    while ((n = w.nextNode())) {
      if (!n.textContent.trim()) continue;
      if (n.parentElement && n.parentElement.closest('.ych-tiers')) continue;
      range.selectNodeContents(n);
      for (const rc of range.getClientRects()) {
        if (rc.width <= 0 || rc.height <= 0) continue;
        // text pushed up so it straddles / sits in the bottom of the artwork
        if (rc.top < art.bottom - 2 && rc.bottom > art.bottom - 24 && rc.left < art.right && rc.right > art.left) return true;
      }
    }
    return false;
  }

  // Does this card now collide with a neighbouring card (e.g. the row below)?
  function nearbyOverlap(card) {
    const cr = card.getBoundingClientRect();
    const check = (sib) => {
      const r = sib.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const ox = Math.min(cr.right, r.right) - Math.max(cr.left, r.left);
      const oy = Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top);
      return ox > 4 && oy > 4;
    };
    let sib = card.previousElementSibling;
    for (let i = 0; sib && i < 16; i++, sib = sib.previousElementSibling) if (check(sib)) return true;
    sib = card.nextElementSibling;
    for (let i = 0; sib && i < 16; i++, sib = sib.nextElementSibling) if (check(sib)) return true;
    return false;
  }

  function revertTall(box) {
    if (box._revertTall) { box._revertTall(); box._revertTall = null; }
  }

  // Let the card (and the containers between it and the chips) grow to fit their content.
  // Keeps the change only if the layout still looks right; otherwise undoes it.
  function tryTall(box, card) {
    const chain = [];
    for (let el = box.parentElement; el && el !== card.parentElement && el !== document.body; el = el.parentElement) chain.push(el);
    const props = ['height', 'max-height'];
    const saved = [];
    chain.forEach((el) => props.forEach((pr) =>
      saved.push([el, pr, el.style.getPropertyValue(pr), el.style.getPropertyPriority(pr)])));
    const parent = card.parentElement;
    const isGrid = !!parent && /grid/.test(getComputedStyle(parent).display);
    const gridSaved = isGrid
      ? [parent.style.getPropertyValue('grid-auto-rows'), parent.style.getPropertyPriority('grid-auto-rows')]
      : null;

    const revert = () => {
      saved.forEach(([el, pr, v, pri]) => {
        if (v) el.style.setProperty(pr, v, pri); else el.style.removeProperty(pr);
      });
      if (isGrid) {
        if (gridSaved[0]) parent.style.setProperty('grid-auto-rows', gridSaved[0], gridSaved[1]);
        else parent.style.removeProperty('grid-auto-rows');
      }
    };

    chain.forEach((el) => {
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('max-height', 'none', 'important');
    });
    if (isGrid) parent.style.setProperty('grid-auto-rows', 'auto', 'important');

    const bb = box.getBoundingClientRect().bottom;
    const contained = chain.every((el) => bb <= el.getBoundingClientRect().bottom + 1);
    const ok = contained && !hasOverlap(box, card, findArtRect(card)) && !nearbyOverlap(card);
    if (!ok) { revert(); return false; }
    box._revertTall = revert;
    return true;
  }

  function fitChips(box) {
    const card = box._card;
    if (!box.isConnected || !card) return;
    const chip = box.firstElementChild;
    if (!chip) return;
    revertTall(box);

    const gap = 4;
    const rowH = chip.getBoundingClientRect().height || 20;
    const maxH = (r) => r * rowH + (r - 1) * gap;
    box.style.maxHeight = 'none';
    const natural = Math.max(1, Math.round((box.scrollHeight + gap) / (rowH + gap)));

    // 0) Everything already fits without touching the card.
    let rows = Math.min(MAX_ROWS_TALL, natural);
    box.style.maxHeight = maxH(rows) + 'px';
    if (!hasOverlap(box, card, findArtRect(card))) {
      box.classList.toggle('ych-clipped', box.scrollHeight > maxH(rows) + 1);
      return;
    }

    // 1) Preferred: make the card itself taller so all rows fit.
    if (natural > 1 && tryTall(box, card)) {
      box.classList.toggle('ych-clipped', box.scrollHeight > maxH(rows) + 1);
      return;
    }

    // 2) Fallback: fewer rows, as many as the fixed-size card can hold.
    rows = Math.min(MAX_ROWS, natural);
    const art = findArtRect(card);
    for (;;) {
      box.style.maxHeight = maxH(rows) + 'px';
      if (rows <= 1 || !hasOverlap(box, card, art)) break;
      rows--;
    }
    box.classList.toggle('ych-clipped', box.scrollHeight > maxH(rows) + 1);
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => document.querySelectorAll('.ych-tiers').forEach(fitChips), 300);
  });

  function makeChip(strong, label, cls) {
    const chip = document.createElement('span');
    chip.className = 'ych-tier' + (cls ? ' ' + cls : '');
    const b = document.createElement('b');
    b.textContent = strong;
    chip.appendChild(b);
    if (label) {
      const l = document.createElement('span');
      l.className = 'ych-lbl';
      l.textContent = label;
      chip.appendChild(l);
    }
    return chip;
  }

  function renderTiers(card, entry) {
    applying = true; // our own DOM edit, not something to react to
    try {
      card.querySelectorAll('.ych-tiers').forEach((e) => e.remove());
      const tiers = ((entry && entry.tiers) || []).slice(0, MAX_CHIPS);
      let price = getPrice(card);
      if (price === null && entry && entry.auc) price = entry.auc;
      card._ychCost = trueCost(tiers, price);
      // No tier list in the description? Still show the true cost chip (it falls back to the current price).
      if (!tiers.length && !card._ychCost) { scheduleSort(); return; }

      const box = document.createElement('div');
      box.className = 'ych-tiers';

      if (card._ychCost) box.appendChild(makeChip(fmtPrice(card._ychCost), 'true cost', 'ych-cost'));

      let lastSection = null;
      tiers.forEach((t) => {
        if (t.section && t.section !== lastSection) {
          const h = document.createElement('div');
          h.className = 'ych-sec';
          h.textContent = t.section;
          box.appendChild(h);
        }
        lastSection = t.section;
        box.appendChild(makeChip(
          (t.add ? '+' : '') + fmtPrice(t.p) + (t.hi ? '–' + fmtPrice(t.hi) : '') + (t.plus ? '+' : ''),
          t.label,
          t.add ? 'ych-add' : (t.ab ? 'ych-ab' : '')
        ));
      });

      box._lines = Array.from(new Set(tiers.map((t) => t.line.replace(/\s+/g, ' ').trim())));
      box.addEventListener('mouseenter', () => showPop(box));
      box.addEventListener('mouseleave', hidePop);

      const pe = findPriceEl(card);
      if (pe) pe.after(box); else card.appendChild(box);
      box._card = card;
      requestAnimationFrame(() => fitChips(box));
      setTimeout(() => fitChips(box), 700); // images may finish loading and shift layout
      card.querySelectorAll('img').forEach((im) => {
        if (!im.complete) im.addEventListener('load', () => fitChips(box), { once: true });
      });
      scheduleSort();
    } finally {
      setTimeout(() => { applying = false; }, 100);
    }
  }

  // ================= Tier fetching (lazy, only for cards on screen; all cards when sorting) =================
  const tierQueue = [];
  let tierActive = 0;
  let tierPausedUntil = 0;
  let tierBackoff = 0;
  let pumpTimer = null;

  async function fetchTiers(card) {
    const href = cardHref(card);
    const id = auctionId(href);
    try {
      const url = new URL(href, location.href).href;
      const res = await fetch(url, { credentials: 'same-origin', priority: 'low' });
      if (res.status === 429 || res.status === 503 || res.status === 403) {
        // The site is asking us to slow down: pause everything and retry this card later.
        tierBackoff = Math.min(tierBackoff + 1, 5);
        const secs = 30 * Math.pow(2, tierBackoff - 1);
        tierPausedUntil = Date.now() + secs * 1000;
        showToast('Site asked to slow down. Tier fetching paused for ' + secs + 's', false);
        hideToast(5000);
        tierQueue.unshift(card);
        return;
      }
      if (!res.ok) throw new Error('http ' + res.status);
      tierBackoff = 0;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const desc = extractDescription(doc);
      const tiers = parseTiers(desc);
      const am = ((doc.body && doc.body.textContent) || '').match(/Auction Price\s*-?\s*\$\s?([\d,]+(?:\.\d+)?)/i);
      const entry = { t: Date.now(), exp: cacheExpiry(card), tiers: tiers, d: desc.slice(0, DESC_KEEP), pv: PARSER_VERSION, auc: am ? parseFloat(am[1].replace(/,/g, '')) : null };
      if (id) { tierCache[id] = entry; saveCache(); }
      renderTiers(card, entry);
    } catch (e) { /* leave card as is */ }
    if (sortOn) {
      const left = tierQueue.length;
      showToast(left ? 'Sorting: ' + left + ' listings left to read' : 'Sorting complete', false);
      if (!left) { hideToast(2000); clearTimeout(sortTimer); applySort(); }
    }
    if (!tierQueue.includes(card)) card.dataset.ychTierDone = '1';
  }

  function pumpTiers() {
    const wait = tierPausedUntil - Date.now();
    if (wait > 0) {
      if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pumpTiers(); }, wait + 100);
      return;
    }
    while (tiersOn && !loading && tierActive < TIER_CONCURRENCY && tierQueue.length) {
      const card = tierQueue.shift();
      tierActive++;
      fetchTiers(card).finally(() => {
        tierActive--;
        setTimeout(pumpTiers, TIER_GAP_MS);
      });
    }
  }

  function enqueueTiers(card) {
    if (card.dataset.ychTierDone || card.dataset.ychTierQ) return;
    const id = auctionId(cardHref(card));
    if (!id) return;
    const hit = cachedTiers(id);
    if (hit) { renderTiers(card, hit); card.dataset.ychTierDone = '1'; return; }
    card.dataset.ychTierQ = '1';
    tierQueue.push(card);
    pumpTiers();
  }

  const io = new IntersectionObserver((entries) => {
    if (loading || !tiersOn) return;
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      enqueueTiers(en.target);
    });
  }, { rootMargin: '400px 0px' });

  // Saved (cached) tiers need no request, so draw them for every card on the page straight away,
  // not just the ones near the screen. Done in batches, one per frame, so a long page doesn't freeze.
  const cachedPending = [];
  let cachedRaf = 0;
  function renderCachedNow(cards) {
    cards.forEach((c) => {
      if (c.dataset.ychTierDone || c.dataset.ychTierQ) return;
      const id = auctionId(cardHref(c));
      if (id && cachedTiers(id)) cachedPending.push(c);
    });
    if (!cachedRaf && cachedPending.length) cachedRaf = requestAnimationFrame(drainCached);
  }
  function drainCached() {
    cachedRaf = 0;
    cachedPending.splice(0, 30).forEach((c) => { if (c.isConnected && !c.dataset.ychTierDone) enqueueTiers(c); });
    if (cachedPending.length) cachedRaf = requestAnimationFrame(drainCached);
  }

  function observeTierCards() {
    if (!tiersOn || !isListingPage()) return;
    renderCachedNow(getCards());
    if (sortOn && !loading) getCards().forEach(enqueueTiers);
    getCards().forEach((c) => {
      if (c.dataset.ychTierObs || c.dataset.ychTierDone) return;
      c.dataset.ychTierObs = '1';
      io.observe(c);
    });
  }

  function refreshTierObservers() {
    // After a load-all (which scrolls past everything), drop the stale queue and
    // re-watch every card so only what's actually on screen gets fetched
    // (or every card, when sorting by true cost).
    io.disconnect();
    tierQueue.length = 0;
    getCards().forEach((c) => { delete c.dataset.ychTierObs; delete c.dataset.ychTierQ; });
    observeTierCards();
  }

  // ================= Buttons + dropdown =================
  const BTN_CSS = 'margin-left:8px;padding:4px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer';

  const loadBtn = document.createElement('button');
  loadBtn.style.cssText = BTN_CSS;
  loadBtn.textContent = 'Load all';
  loadBtn.title = 'Loads every listing (scrolls / clicks "Show more" / follows pages)';
  loadBtn.addEventListener('click', (e) => { e.preventDefault(); loadAll(); });

  const tierBtn = document.createElement('button');
  tierBtn.id = 'ych-tiers-btn';
  tierBtn.style.cssText = BTN_CSS;
  const updateTierBtn = () => { tierBtn.textContent = 'Price tiers: ' + (tiersOn ? 'On' : 'Off'); };
  updateTierBtn();
  tierBtn.addEventListener('click', (e) => {
    e.preventDefault();
    tiersOn = !tiersOn;
    try { localStorage.setItem(TIERS_ON_KEY, tiersOn ? '1' : '0'); } catch (err) {}
    document.documentElement.classList.toggle('ych-tiers-off', !tiersOn);
    updateTierBtn();
    if (tiersOn) refreshTierObservers();
  });

  const sortBtn = document.createElement('button');
  sortBtn.style.cssText = BTN_CSS;
  sortBtn.title = 'Sort by highest tier (or current price if higher), lowest first. Loads all listings and reads every tier list first.';
  const updateSortBtn = () => { sortBtn.textContent = 'Sort by true cost: ' + (sortOn ? 'On' : 'Off'); };
  updateSortBtn();
  sortBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    sortOn = !sortOn;
    try { localStorage.setItem(SORT_KEY, sortOn ? '1' : '0'); } catch (err) {}
    updateSortBtn();
    if (sortOn) {
      if (!tiersOn) tierBtn.click(); // sorting needs tier data
      await loadAll();               // ends by queueing every card for tier reading
      applySort();
    } else {
      clearTimeout(sortTimer);
      applySort();                   // back to the dropdown's order
    }
  });

  const clearBtn = document.createElement('button');
  clearBtn.style.cssText = BTN_CSS;
  cacheCountEl = clearBtn;
  updateCacheCount();
  clearBtn.title = 'Forget saved price tiers and re-read them from the listings';
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    clearTimeout(saveTimer);
    tierCache = {};
    try { localStorage.removeItem(TIERS_CACHE_KEY); } catch (err) {}
    tierQueue.length = 0;
    document.querySelectorAll('.ych-tiers').forEach((b) => { revertTall(b); b.remove(); });
    getCards().forEach((c) => {
      delete c.dataset.ychTierDone; delete c.dataset.ychTierQ; delete c.dataset.ychTierObs; delete c._ychCost;
    });
    showToast('Tier cache cleared, reloading tiers…', false);
    hideToast(2000);
    refreshTierObservers();
  });

  const ALL_BTNS = [loadBtn, tierBtn, sortBtn, clearBtn];
  let fallbackBar = null;

  function ensureOptions() {
    const sel = findSortSelect();
    if (!sel) return false;
    if (!sel.querySelector('option[value="' + VAL_ASC + '"]')) {
      sel.add(new Option('Price: low to high', VAL_ASC));
      sel.add(new Option('Price: high to low', VAL_DESC));
      if (mode === 'asc') sel.value = VAL_ASC;
      if (mode === 'desc') sel.value = VAL_DESC;
    }
    if (fallbackBar) { fallbackBar.remove(); fallbackBar = null; ALL_BTNS.forEach((b) => { b.style.color = ''; }); }
    // Only (re)insert when our buttons aren't next to the dropdown's container yet
    if (ALL_BTNS.some((b) => b.parentElement !== sel.parentElement)) {
      let prev = sel;
      ALL_BTNS.forEach((b) => { prev.insertAdjacentElement('afterend', b); prev = b; });
    }
    return true;
  }

  function onSelectEvent(e) {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement)) return;
    if (!t.querySelector('option[value="' + VAL_ASC + '"]')) return;
    if (t.value === VAL_ASC || t.value === VAL_DESC) {
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.type === 'change') setMode(t.value === VAL_ASC ? 'asc' : 'desc');
    } else if (e.type === 'change' && mode !== 'default') {
      setMode('default');
    }
  }
  document.addEventListener('change', onSelectEvent, true);
  document.addEventListener('input', onSelectEvent, true);

  function buildFallbackBar() {
    if (fallbackBar || document.getElementById('ych-price-bar')) return;
    const box = document.createElement('div');
    box.id = 'ych-price-bar';
    box.style.cssText = 'position:fixed;right:16px;bottom:70px;z-index:999999;display:flex;flex-wrap:wrap;gap:6px;max-width:92vw;padding:8px;border-radius:10px;background:rgba(30,30,30,.92);color:#fff;font:13px system-ui,sans-serif;align-items:center';
    box.appendChild(Object.assign(document.createElement('span'), { textContent: 'Sort:' }));
    [['default', 'Default'], ['asc', 'Price ↑'], ['desc', 'Price ↓']].forEach(([k, t]) => {
      const b = document.createElement('button');
      b.textContent = t;
      b.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:6px 10px;background:#444;color:#fff;font:inherit';
      b.onclick = () => setMode(k);
      box.appendChild(b);
    });
    ALL_BTNS.forEach((b) => { b.style.color = '#fff'; box.appendChild(b); });
    document.body.appendChild(box);
    fallbackBar = box;
  }

  // ================= Wiring =================
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    if (applying || loading) return;
    ensureOptions();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(observeTierCards, 300);
  });

  ensureOptions();
  getCards();
  observer.observe(document.body, { childList: true, subtree: true });
  observeTierCards();

  async function autoRestore() {
    if (mode === 'default' && !sortOn) return;
    for (let i = 0; i < 10 && !findSortSelect(); i++) await sleep(300);
    if (!findSortSelect()) return;
    await loadAll();
    applySort();
    window.scrollTo(0, 0);
  }
  autoRestore();

  setTimeout(() => { if (!findSortSelect() && isListingUrl()) buildFallbackBar(); }, 3000);
})();