// ==UserScript==
// @name         YCH.art Price Tiers
// @namespace    https://ych.art/
// @version      1.22
// @description  Price tiers under each YCH.art card, equal row heights, optional "Load all" button, optional slow background prefetch, price sort + true-cost sort in the sort dropdown (sorts what is loaded, remembers your choice)
// @match        https://ych.art/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.__ychartTiersLoaded) return; // never run twice on the same page
  window.__ychartTiersLoaded = true;

  // ================= Config =================
  const TIERS_ON_KEY = 'ychart-tiers-on';
  const MODE_KEY = 'ychart-sort-mode';
  const OLD_SORT_KEY = 'ychart-sort-on'; // v1.3 true-cost toggle, migrated below
  const TIERS_CACHE_KEY = 'ychart-tiers-cache-v10';
  try { localStorage.removeItem('ychart-tiers-cache-v8'); localStorage.removeItem('ychart-tiers-cache-v9'); } catch (e) {} // old cache read these listings without their tiers
  const PREFETCH_KEY = 'ychart-prefetch-on';
  const PREFETCH_GAP_MS = 1500;     // one background fetch at a time, this far apart
  const VAL_PRICE_ASC = '__price_asc';
  const VAL_PRICE_DESC = '__price_desc';
  const VAL_COST_ASC = '__cost_asc';
  const VALUE_TO_MODE = {};
  VALUE_TO_MODE[VAL_PRICE_ASC] = 'price_asc';
  VALUE_TO_MODE[VAL_PRICE_DESC] = 'price_desc';
  VALUE_TO_MODE[VAL_COST_ASC] = 'cost_asc';
  const MODE_TO_VALUE = {};
  Object.keys(VALUE_TO_MODE).forEach((v) => { MODE_TO_VALUE[VALUE_TO_MODE[v]] = v; });

  const TIER_CONCURRENCY = 2;
  const TIER_GAP_MS = 400;
  const TIER_CACHE_DAYS = 7;        // fallback when an auction's end time can't be read
  const MAX_CACHE_DAYS = 14;        // never keep an entry longer than this, even if the auction runs longer
  const TIER_CACHE_MAX = 1500;
  const CACHE_SAVE_DELAY = 5000;
  const MAX_LOAD_ROUNDS = 300;
  const MAX_PAGES = 60;
  const SCROLL_DELAY = 800;
  const STABLE_ROUNDS_TO_STOP = 3;

  let tiersOn = true;
  try { tiersOn = (localStorage.getItem(TIERS_ON_KEY) || '1') === '1'; } catch (e) {}

  // mode: 'default' | 'price_asc' | 'price_desc' | 'cost_asc'
  let mode = 'default';
  try {
    mode = localStorage.getItem(MODE_KEY) || (localStorage.getItem(OLD_SORT_KEY) === '1' ? 'cost_asc' : 'default');
  } catch (e) {}
  if (mode !== 'default' && !MODE_TO_VALUE[mode]) mode = 'default';

  let prefetchOn = false;
  try { prefetchOn = localStorage.getItem(PREFETCH_KEY) === '1'; } catch (e) {}

  // Layout timing, readable from the console: __ychartStats
  const stats = window.__ychartStats = { relayouts: 0, lastMs: 0, maxMs: 0, totalMs: 0, cards: 0, cacheHits: 0, fetches: 0 };

  let loading = false;
  let cancelled = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ================= Card helpers =================
  const isGoLink = (a) => /^go to auction$/i.test((a.textContent || '').trim());

  function cardFromLink(a) {
    const t = a.closest('.auction-tile2');
    if (t) return t; // fast path
    const stop = a.ownerDocument.body;
    let el = a;
    while (el.parentElement && el.parentElement !== stop) {
      const p = el.parentElement;
      const n = Array.from(p.querySelectorAll('a')).filter(isGoLink).length;
      if (n > 1) break;
      el = p;
    }
    return el;
  }

  // root defaults to the live page (result cached briefly); pass a parsed document to read another page's cards
  let cardsCache = null, cardsCacheAt = 0;
  function invalidateCards() { cardsCache = null; }

  function getCards(root) {
    const live = !root;
    if (live && cardsCache && Date.now() - cardsCacheAt < 400) return cardsCache.filter((c) => c.isConnected);
    root = root || document;
    const cards = [];
    const seen = new Set();
    root.querySelectorAll('a').forEach((a) => {
      if (!isGoLink(a) || a.closest('.ychart-tiers')) return;
      const el = cardFromLink(a);
      if (seen.has(el)) return;
      seen.add(el);
      cards.push(el);
    });
    if (live) { cardsCache = cards; cardsCacheAt = Date.now(); }
    return cards;
  }

  function cardHref(card) {
    const go = Array.from(card.querySelectorAll('a')).find(isGoLink);
    const a = go || card.querySelector('a[href*="/auction/"]');
    return a ? a.getAttribute('href') : null;
  }

  function auctionId(href) {
    const m = (href || '').match(/\/auction\/(\d+)/);
    return m ? m[1] : null;
  }

  // Current bid / auto-buy prices as printed on the card ("Bid $45 ... AB $350").
  function cardText(card) {
    let txt = '';
    const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (n.parentElement && n.parentElement.closest('.ychart-tiers')) continue;
      txt += n.textContent + ' ';
    }
    return txt;
  }
  function dollars(seg) {
    return Array.from((seg || '').matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)).map((m) => parseFloat(m[1].replace(/,/g, '')));
  }
  function cardPrices(card) {
    const txt = cardText(card);
    const b = txt.match(/\bBid\b([\s\S]*?)(?=\bAB\b|\bWatch\b|\bHide\b|$)/);
    const a = txt.match(/\bAB\b([\s\S]*?)(?=\bBid\b|\bWatch\b|\bHide\b|$)/);
    return { bid: dollars(b && b[1]), ab: dollars(a && a[1]) };
  }

  // The card's current price, used by the plain price sort: lowest current bid,
  // else the auction price read from the listing page, else the lowest Buy now.
  function currentPrice(card) {
    const cur = cardPrices(card);
    if (cur.bid.length) return Math.min.apply(null, cur.bid);
    if (card._ychartAuc) return card._ychartAuc;
    if (cur.ab.length) return Math.min.apply(null, cur.ab);
    return null;
  }

  // ================= Toast =================
  let toast = null;
  function showToast(text, withStop) {
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:10px;background:rgba(30,30,30,.94);color:#fff;font:13px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      toast.innerHTML = '<span class="m"></span><button style="cursor:pointer;border:0;border-radius:6px;padding:5px 9px;background:#c0392b;color:#fff;font:inherit">Stop</button>';
      toast.querySelector('button').onclick = () => { cancelled = true; };
      document.body.appendChild(toast);
    }
    toast.querySelector('.m').textContent = text;
    toast.querySelector('button').style.display = withStop ? '' : 'none';
    toast.style.display = 'flex';
  }
  function hideToast(delay) { setTimeout(() => { if (toast) toast.style.display = 'none'; }, delay || 0); }

  // ================= Load everything =================
  // Three strategies, in order: infinite scroll + "Show more" buttons, then "Next page" links.
  function findShowMore() {
    return Array.from(document.querySelectorAll('button, a, [role="button"], div, span')).find((el) => {
      if (el.offsetParent === null || el.children.length > 1) return false;
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
    invalidateCards();
    let last = getCards().length;
    let stable = 0;
    for (let i = 0; i < MAX_LOAD_ROUNDS && !cancelled; i++) {
      const btn = findShowMore();
      if (btn) btn.click();
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(SCROLL_DELAY / 2);
      window.scrollBy(0, -400); // nudge so scroll-triggered loaders fire again
      await sleep(100);
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(SCROLL_DELAY / 2);
      invalidateCards();
      const count = getCards().length;
      showToast('Loading all listings… ' + count + ' found', true);
      if (count === last) { if (++stable >= (btn ? 4 : STABLE_ROUNDS_TO_STOP)) break; }
      else { stable = 0; last = count; }
    }
  }

  async function pageLoad() {
    invalidateCards();
    const existing = new Set(getCards().map(cardHref));
    let url = findNextUrl(document, location.href);
    let pages = 0;
    while (url && pages < MAX_PAGES && !cancelled) {
      invalidateCards();
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
      invalidateCards();
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
      invalidateCards();
      const n = getCards().length;
      const sorting = mode !== 'default';
      showToast(cancelled ? 'Stopped at ' + n + ' listings' + (sorting ? '. Sorting those' : '') : 'Loaded ' + n + ' listings', false);
      hideToast(2500);
      refreshTierObservers();
    }
  }

  // ================= Sort mode =================
  async function setMode(newMode) {
    mode = newMode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    updateSortBtn();
    syncSelect();
    if (mode === 'default') { cancelled = true; refreshTierObservers(); return; }
    if (mode === 'cost_asc' && !tiersOn) setTiers(true); // true cost needs tier data
    // Sorts whatever is already on the page (no scrolling, no loading more).
    // For true cost this also queues every card on the page so its tiers get read.
    refreshTierObservers();
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
    return s.length > 60 ? s.slice(0, 59).trimEnd() + '…' : s;
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

  function nodeText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style').forEach((e) => e.remove());
    c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    c.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6').forEach((e) => e.append('\n'));
    return c.textContent;
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

  // The meta description is truncated and has its line breaks flattened, so find the real
  // description block: the smallest element whose text contains the start of that summary.
  function extractDescription(doc) {
    const metaEl = doc.querySelector('meta[property="og:description"]') || doc.querySelector('meta[name="description"]');
    const meta = metaEl ? (metaEl.getAttribute('content') || '') : '';
    const key = meta.replace(/(\.{3}|…)\s*$/, '').replace(/\s+/g, '').slice(0, 60);
    const best = key.length >= 8 ? smallestContaining(doc, key) : '';
    return best.length >= meta.length ? best : meta;
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

  // ================= Rendering =================
  // Inline styles only (the site's CSP can block injected <style> elements)
  const CSS = {
    box: 'flex:0 0 100%;width:100%;box-sizing:border-box;padding:5px 6px 7px;background:rgba(0,0,0,.28);border-top:1px solid rgba(255,255,255,.12);text-align:left;font:11px/16px system-ui,sans-serif;color:#eee;cursor:help',
    row: 'display:flex;flex-wrap:wrap;gap:3px;margin:2px 0',
    head: 'font-weight:700;font-size:10px;letter-spacing:.05em;text-transform:uppercase;opacity:.8;margin:6px 0 1px',
    chip: 'display:inline-flex;align-items:baseline;gap:4px;max-width:100%;box-sizing:border-box;padding:0 7px;border-radius:10px;background:#b3261e;color:#fff;border:1px solid rgba(255,255,255,.3);white-space:normal;text-align:left',
    add: 'background:#555',
    bid: 'background:#1f7a46',
    ab: 'background:#2a62c9',
    cost: 'background:#b36b00',
    pop: 'position:fixed;z-index:2147483647;display:none;pointer-events:none;max-width:min(420px,92vw);box-sizing:border-box;background:#222;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.5);padding:6px 10px;font:12px/1.4 system-ui,sans-serif;text-align:left',
    b: 'font-weight:700;white-space:nowrap',
    lbl: 'min-width:0;font-weight:400;overflow-wrap:anywhere'
  };

  const fmtPrice = (p) => '$' + (Number.isInteger(p) ? p : p.toFixed(2));

  function makeChip(strong, label, extraCss) {
    const chip = document.createElement('span');
    chip.style.cssText = CSS.chip + (extraCss ? ';' + extraCss : '');
    const b = document.createElement('b');
    b.style.cssText = CSS.b;
    b.textContent = strong;
    chip.appendChild(b);
    if (label) {
      const l = document.createElement('span');
      l.style.cssText = CSS.lbl;
      l.textContent = label;
      chip.appendChild(l);
    }
    return chip;
  }

  let pop = null;
  function showPop(box) {
    const lines = box._lines || [];
    if (!lines.length) return;
    if (!pop) {
      pop = document.createElement('div');
      pop.style.cssText = CSS.pop;
      document.body.appendChild(pop);
      window.addEventListener('scroll', hidePop, { passive: true });
    }
    pop.textContent = '';
    lines.forEach((l, i) => {
      const d = document.createElement('div');
      d.textContent = l;
      d.style.cssText = 'white-space:normal;overflow-wrap:anywhere;padding:3px 0' + (i ? ';border-top:1px solid rgba(255,255,255,.15)' : '');
      pop.appendChild(d);
    });
    pop.style.display = 'block';
    const r = box.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = r.top - h - 4;
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, top) + 'px';
  }
  function hidePop() { if (pop) pop.style.display = 'none'; }

  function countPrices(list) {
    const m = new Map();
    list.forEach((p) => m.set(p, (m.get(p) || 0) + 1));
    return Array.from(m.entries());
  }

  // "True cost": the higher of the most expensive tier (top of a range counts; add-ons and AB-only tiers don't)
  // and the current bid. No tiers -> current bid. Buy now / AB is ignored. null = no price info.
  function trueCost(tiers, cur) {
    const tierMax = tiers.filter((t) => !t.add && !t.ab).reduce((m, t) => Math.max(m, t.hi || t.p), 0);
    const bid = cur.bid.length ? Math.max.apply(null, cur.bid) : 0;
    const c = Math.max(tierMax, bid);
    return c > 0 ? c : null;
  }

  function renderCard(card, entry) {
    const slow = !!card._ychartPrefetch;
    card._ychartPrefetch = false;
    card.querySelectorAll('.ychart-tiers').forEach((e) => e.remove());
    const tiers = (entry && entry.tiers) || [];
    const cur = cardPrices(card);
    card._ychartAuc = (entry && entry.auc) || null;
    if (!cur.bid.length && !cur.ab.length && entry && entry.auc) cur.bid = [entry.auc];
    card._ychartCost = trueCost(tiers, cur);
    if (!tiers.length && !cur.bid.length && !cur.ab.length) { scheduleEqualize(slow); return; }

    const box = document.createElement('div');
    box.className = 'ychart-tiers';
    box.style.cssText = CSS.box + (tiersOn ? '' : ';display:none');

    if (cur.bid.length || cur.ab.length) {
      const row = document.createElement('div');
      row.style.cssText = CSS.row;
      countPrices(cur.bid).forEach(([p, n]) => row.appendChild(makeChip('Bid', fmtPrice(p) + (n > 1 ? ' ×' + n : ''), CSS.bid)));
      countPrices(cur.ab).forEach(([p, n]) => row.appendChild(makeChip('Buy now', fmtPrice(p) + (n > 1 ? ' ×' + n : ''), CSS.ab)));
      if (card._ychartCost) row.appendChild(makeChip('True cost', fmtPrice(card._ychartCost), CSS.cost));
      box.appendChild(row);
    }

    // Group tiers by section (in order of first appearance)
    const groups = new Map();
    tiers.forEach((t) => {
      if (!groups.has(t.section)) groups.set(t.section, []);
      groups.get(t.section).push(t);
    });
    groups.forEach((list, section) => {
      if (section) {
        const h = document.createElement('div');
        h.style.cssText = CSS.head;
        h.textContent = section;
        box.appendChild(h);
      } else if (cur.bid.length || cur.ab.length) {
        const h = document.createElement('div');
        h.style.cssText = CSS.head;
        h.textContent = 'Tiers';
        box.appendChild(h);
      }
      const row = document.createElement('div');
      row.style.cssText = CSS.row;
      list.forEach((t) => row.appendChild(makeChip((t.add ? '+' : '') + fmtPrice(t.p) + (t.hi ? '–' + fmtPrice(t.hi) : '') + (t.plus ? '+' : ''), t.label, t.add ? CSS.add : (t.ab ? CSS.ab : ''))));
      box.appendChild(row);
    });

    box._lines = Array.from(new Set(tiers.map((t) => t.line.replace(/\s+/g, ' ').trim())));
    box.addEventListener('mouseenter', () => showPop(box));
    box.addEventListener('mouseleave', hidePop);

    // Let the card grow so the block shows in full
    card.style.setProperty('height', 'auto', 'important');
    card.style.setProperty('max-height', 'none', 'important');
    card.style.setProperty('overflow', 'visible', 'important');
    card.appendChild(box);
    card.querySelectorAll('img').forEach((im) => {
      if (!im.complete) im.addEventListener('load', () => scheduleEqualize(slow), { once: true });
    });
    scheduleEqualize(slow);
  }

  // ================= Row layout =================
  // The site lays cards out with its own masonry code and doesn't expect them to grow.
  // So we take over positioning: every pass restores the site's own styles, measures the
  // natural layout (columns + card widths), then re-places the cards in clean rows where
  // each row is as tall as its tallest card. With a sort mode on, the cards are placed in
  // sorted order instead of the site's order (the page's DOM order is never touched).
  const ROW_GAP = 12;
  const LAYOUT_PROPS = ['position', 'left', 'top', 'transform', 'margin', 'width', 'min-height', 'height', 'max-height', 'align-self', 'transition'];
  let eqTimer = null, eqTimer2 = null;

  // Coalesced. The bigger the page, the less often we re-place every card:
  // delay grows with the card count, and background prefetch results wait even longer.
  function scheduleEqualize(slow) {
    const busy = tierQueue.length > 0 || tierActive > 0;
    const n = cardsCache ? cardsCache.length : 0;
    let delay = busy ? 1500 : 250;
    delay += Math.min(3000, n * 2);
    if (slow) delay = Math.max(delay, 5000);
    if (!eqTimer) eqTimer = setTimeout(() => { eqTimer = null; relayout(); }, delay);
    // second pass for lazy images / the site's own layout, only worthwhile on small pages
    if (!busy && n < 200 && !eqTimer2) eqTimer2 = setTimeout(() => { eqTimer2 = null; relayout(); }, 900);
  }

  function saveStyles(el, props) {
    el._ychartOrig = {};
    props.forEach((p) => { el._ychartOrig[p] = [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]; });
  }
  function restoreStyles(el) {
    if (!el._ychartOrig) return;
    Object.keys(el._ychartOrig).forEach((p) => {
      const v = el._ychartOrig[p];
      if (v[0]) el.style.setProperty(p, v[0], v[1]); else el.style.removeProperty(p);
    });
    el._ychartOrig = null;
  }
  const imp = (el, p, v) => el.style.setProperty(p, v, 'important');

  function relayout() {
    const t0 = performance.now();
    const all = getCards().filter((c) => c.offsetParent !== null);
    if (!all.length) return;
    const parent = all[0].parentElement;
    const cards = all.filter((c) => c.parentElement === parent);

    // 1) back to the site's own layout
    cards.forEach(restoreStyles);
    restoreStyles(parent);
    cards.forEach((c) => saveStyles(c, LAYOUT_PROPS));
    saveStyles(parent, ['position', 'height', 'min-height']);

    // 2) natural size of each card (content height), plus the site's columns and widths
    cards.forEach((c) => { imp(c, 'height', 'auto'); imp(c, 'min-height', '0'); imp(c, 'max-height', 'none'); imp(c, 'align-self', 'start'); });
    const pr = parent.getBoundingClientRect();
    const info = cards.map((c) => {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      const pad = cs.boxSizing === 'content-box'
        ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
        : 0;
      return { c: c, x: r.left - pr.left - parent.clientLeft, y: r.top - pr.top - parent.clientTop, h: r.height, w: cs.width, pad: pad };
    });
    const xs = Array.from(new Set(info.map((i) => Math.round(i.x)))).sort((a, b) => a - b);
    const lefts = [];
    xs.forEach((x) => { if (!lefts.length || x - lefts[lefts.length - 1] > 8) lefts.push(x); });
    const n = lefts.length;
    if (!n) return;
    const startY = Math.max(0, Math.min.apply(null, info.map((i) => i.y)));

    // Optional ordering. Array.sort is stable, so ties keep the site's order.
    if (mode === 'cost_asc') {
      // true cost, lowest first; unknown (tiers not read yet) last, known-but-no-price just before
      const key = (i) => i.c._ychartCost === undefined ? 1e10 : (i.c._ychartCost === null ? 1e9 : i.c._ychartCost);
      info.sort((a, b) => key(a) - key(b));
    } else if (mode === 'price_asc' || mode === 'price_desc') {
      const dir = mode === 'price_asc' ? 1 : -1;
      info.forEach((i) => { i.pr = currentPrice(i.c); });
      info.sort((a, b) => {
        if (a.pr === null && b.pr === null) return 0;
        if (a.pr === null) return 1;
        if (b.pr === null) return -1;
        return dir * (a.pr - b.pr);
      });
    }

    // 3) place in rows (left to right)
    let y = startY;
    for (let i = 0; i < info.length; i += n) {
      const row = info.slice(i, i + n);
      const rowH = Math.ceil(Math.max.apply(null, row.map((r) => r.h)));
      row.forEach((r, j) => {
        imp(r.c, 'position', 'absolute');
        imp(r.c, 'left', lefts[j] + 'px');
        imp(r.c, 'top', y + 'px');
        imp(r.c, 'transform', 'none');
        imp(r.c, 'transition', 'none');
        imp(r.c, 'margin', '0');
        imp(r.c, 'width', r.w);
        imp(r.c, 'min-height', (rowH - r.pad) + 'px');
      });
      y += rowH + ROW_GAP;
    }
    if (getComputedStyle(parent).position === 'static') imp(parent, 'position', 'relative');
    imp(parent, 'height', Math.ceil(y + 8) + 'px');
    imp(parent, 'min-height', '0');
    const dt = performance.now() - t0;
    stats.relayouts++; stats.lastMs = Math.round(dt); stats.maxMs = Math.max(stats.maxMs, Math.round(dt));
    stats.totalMs += Math.round(dt); stats.cards = cards.length;
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(scheduleEqualize, 300); });

  // ================= Tier fetching (lazy, only for cards on screen; all cards for true-cost sort) =================
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
      stats.fetches++;
      const entry = { t: Date.now(), exp: cacheExpiry(card), tiers: tiers, d: desc.slice(0, DESC_KEEP), pv: PARSER_VERSION, auc: am ? parseFloat(am[1].replace(/,/g, '')) : null };
      if (id) { tierCache[id] = entry; saveCache(); }
      renderCard(card, entry);
    } catch (e) { /* leave card as is */ }
    if (mode === 'cost_asc') {
      const left = tierQueue.length;
      showToast(left ? 'Sorting: ' + left + ' listings left to read' : 'Sorting complete', false);
      if (!left) hideToast(2000);
    }
    if (!tierQueue.includes(card)) card.dataset.ychartDone = '1';
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
    if (card.dataset.ychartDone || card.dataset.ychartQ) return;
    const id = auctionId(cardHref(card));
    if (!id) return;
    const hit = cachedTiers(id);
    if (hit) { stats.cacheHits++; renderCard(card, hit); card.dataset.ychartDone = '1'; return; }
    card.dataset.ychartQ = '1';
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
      if (c.dataset.ychartDone || c.dataset.ychartQ) return;
      const id = auctionId(cardHref(c));
      if (id && cachedTiers(id)) cachedPending.push(c);
    });
    if (!cachedRaf && cachedPending.length) cachedRaf = requestAnimationFrame(drainCached);
  }
  function drainCached() {
    cachedRaf = 0;
    cachedPending.splice(0, 30).forEach((c) => { if (c.isConnected && !c.dataset.ychartDone) enqueueTiers(c); });
    if (cachedPending.length) cachedRaf = requestAnimationFrame(drainCached);
  }

  function observeTierCards() {
    if (!tiersOn || /^\/auction\//.test(location.pathname)) return;
    renderCachedNow(getCards());
    if (mode === 'cost_asc' && !loading) getCards().forEach(enqueueTiers);
    getCards().forEach((c) => {
      if (c.dataset.ychartObs || c.dataset.ychartDone) return;
      c.dataset.ychartObs = '1';
      io.observe(c);
    });
  }

  function refreshTierObservers() {
    io.disconnect();
    tierQueue.length = 0;
    invalidateCards();
    getCards().forEach((c) => { delete c.dataset.ychartObs; delete c.dataset.ychartQ; });
    observeTierCards();
    scheduleEqualize();
  }

  // ================= Background prefetch =================
  // Slowly reads tiers for every listing on the page that isn't cached yet, one at a time,
  // so later visits and the true-cost sort find them ready. Pauses while the tab is hidden,
  // while anything else is loading, and during a site back-off.
  let prefetchTimer = null;
  function uncachedCards() {
    return getCards().filter((c) => !c.dataset.ychartDone && !c.dataset.ychartQ && auctionId(cardHref(c)) && !cachedTiers(auctionId(cardHref(c))));
  }
  function updatePrefetchBtn(left) {
    prefetchBtn.textContent = 'Prefetch: ' + (prefetchOn ? 'On' + (left ? ' (' + left + ' left)' : '') : 'Off');
  }
  function prefetchTick() {
    prefetchTimer = null;
    if (!prefetchOn) return;
    const idle = tiersOn && !loading && document.visibilityState === 'visible' &&
      tierQueue.length === 0 && tierActive === 0 && Date.now() >= tierPausedUntil && !/^\/auction\//.test(location.pathname);
    if (idle) {
      const todo = uncachedCards();
      updatePrefetchBtn(todo.length);
      if (todo.length) {
        const card = todo[0];
        card._ychartPrefetch = true;
        enqueueTiers(card);
      }
    }
    prefetchTimer = setTimeout(prefetchTick, PREFETCH_GAP_MS);
  }
  function setPrefetch(on) {
    prefetchOn = on;
    try { localStorage.setItem(PREFETCH_KEY, on ? '1' : '0'); } catch (e) {}
    clearTimeout(prefetchTimer); prefetchTimer = null;
    updatePrefetchBtn(0);
    if (on) prefetchTick();
  }

  // ================= Buttons + dropdown =================
  const BTN_CSS = 'margin-left:8px;padding:4px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer';

  const tierBtn = document.createElement('button');
  tierBtn.style.cssText = BTN_CSS;
  const updateTierBtn = () => { tierBtn.textContent = 'Price tiers: ' + (tiersOn ? 'On' : 'Off'); };
  updateTierBtn();
  function setTiers(on) {
    tiersOn = on;
    try { localStorage.setItem(TIERS_ON_KEY, tiersOn ? '1' : '0'); } catch (err) {}
    document.querySelectorAll('.ychart-tiers').forEach((b) => { b.style.display = tiersOn ? '' : 'none'; });
    updateTierBtn();
    if (tiersOn) refreshTierObservers(); else scheduleEqualize();
  }
  tierBtn.addEventListener('click', (e) => { e.preventDefault(); setTiers(!tiersOn); });

  const sortBtn = document.createElement('button');
  sortBtn.style.cssText = BTN_CSS;
  sortBtn.title = 'Sort by highest tier (or current bid if higher), lowest first. Works on the listings currently loaded.';
  function updateSortBtn() { sortBtn.textContent = 'Sort by true cost: ' + (mode === 'cost_asc' ? 'On' : 'Off'); }
  updateSortBtn();
  sortBtn.addEventListener('click', (e) => {
    e.preventDefault();
    setMode(mode === 'cost_asc' ? 'default' : 'cost_asc');
  });

  const prefetchBtn = document.createElement('button');
  prefetchBtn.style.cssText = BTN_CSS;
  prefetchBtn.title = 'Slowly reads tiers for listings not cached yet (one request every ~1.5 s), only while this tab is visible. Loads the listings currently on the page; use Load all first to cover everything.';
  updatePrefetchBtn(0);
  prefetchBtn.addEventListener('click', (e) => { e.preventDefault(); setPrefetch(!prefetchOn); });

  const loadBtn = document.createElement('button');
  loadBtn.style.cssText = BTN_CSS;
  loadBtn.textContent = 'Load all';
  loadBtn.title = 'Keeps scrolling / clicking "Show more" / following next pages until every listing is loaded';
  loadBtn.addEventListener('click', (e) => { e.preventDefault(); loadAll(); });

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
    document.querySelectorAll('.ychart-tiers').forEach((b) => b.remove());
    invalidateCards();
    getCards().forEach((c) => { delete c.dataset.ychartDone; delete c.dataset.ychartQ; delete c.dataset.ychartObs; delete c._ychartCost; delete c._ychartAuc; });
    showToast('Tier cache cleared, reloading tiers…', false);
    hideToast(2000);
    refreshTierObservers();
  });

  function findSortSelect() {
    return Array.from(document.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => /ending soon|newly listed|price \(lowest\)/i.test(o.textContent))
    );
  }

  // Remember what the site's own sort was, so turning our sort off can put it back in the dropdown.
  let lastSiteValue = null;
  function syncSelect() {
    const sel = findSortSelect();
    if (!sel || !sel.querySelector('option[value="' + VAL_PRICE_ASC + '"]')) return;
    if (MODE_TO_VALUE[mode]) sel.value = MODE_TO_VALUE[mode];
    else if (lastSiteValue !== null && VALUE_TO_MODE[sel.value]) sel.value = lastSiteValue;
  }

  function ensureOptions(sel) {
    if (sel.querySelector('option[value="' + VAL_PRICE_ASC + '"]')) return;
    if (!VALUE_TO_MODE[sel.value]) lastSiteValue = sel.value;
    sel.add(new Option('Price: low to high', VAL_PRICE_ASC));
    sel.add(new Option('Price: high to low', VAL_PRICE_DESC));
    sel.add(new Option('True cost: low to high', VAL_COST_ASC));
    if (MODE_TO_VALUE[mode]) sel.value = MODE_TO_VALUE[mode];
  }

  // Capture phase, so the site never sees our custom options (it would try to reload the list).
  function onSelectEvent(e) {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement)) return;
    if (!t.querySelector('option[value="' + VAL_PRICE_ASC + '"]')) return;
    const m = VALUE_TO_MODE[t.value];
    if (m) {
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.type === 'change') setMode(m);
    } else if (e.type === 'change') {
      lastSiteValue = t.value;
      if (mode !== 'default') setMode('default');
    }
  }
  document.addEventListener('change', onSelectEvent, true);
  document.addEventListener('input', onSelectEvent, true);

  let fallbackBar = null;
  function ensureButtons() {
    const sel = findSortSelect();
    if (sel) {
      ensureOptions(sel);
      if (fallbackBar) { fallbackBar.remove(); fallbackBar = null; }
      // Only (re)insert when our buttons aren't next to the dropdown's container yet;
      // never fight other scripts over exact ordering.
      if ([loadBtn, tierBtn, clearBtn, sortBtn, prefetchBtn].some((b) => b.parentElement !== sel.parentElement)) {
        sel.insertAdjacentElement('afterend', loadBtn);
        loadBtn.insertAdjacentElement('afterend', tierBtn);
        tierBtn.insertAdjacentElement('afterend', clearBtn);
        clearBtn.insertAdjacentElement('afterend', sortBtn);
        sortBtn.insertAdjacentElement('afterend', prefetchBtn);
      }
      return;
    }
    if (!fallbackBar && getCards().length) {
      fallbackBar = document.createElement('div');
      fallbackBar.style.cssText = 'position:fixed;right:16px;bottom:70px;z-index:999999;display:flex;flex-wrap:wrap;gap:6px;padding:8px;border-radius:10px;background:rgba(30,30,30,.92);color:#fff;font:13px system-ui,sans-serif;align-items:center;max-width:92vw';
      fallbackBar.appendChild(Object.assign(document.createElement('span'), { textContent: 'Sort:' }));
      [['default', 'Default'], ['price_asc', 'Price ↑'], ['price_desc', 'Price ↓']].forEach(([k, t]) => {
        const b = document.createElement('button');
        b.textContent = t;
        b.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:6px 10px;background:#444;color:#fff;font:inherit';
        b.onclick = () => setMode(k);
        fallbackBar.appendChild(b);
      });
      fallbackBar.append(loadBtn, tierBtn, sortBtn, clearBtn, prefetchBtn);
      loadBtn.style.color = tierBtn.style.color = sortBtn.style.color = clearBtn.style.color = prefetchBtn.style.color = '#fff';
      document.body.appendChild(fallbackBar);
    }
  }

  // ================= Wiring =================
  // Ignores the script's own DOM edits (tier boxes, buttons, toast, popup) so they don't trigger rescans.
  let scanTimer = null;
  const isOurs = (n) => n.nodeType !== 1 ||
    n.classList.contains('ychart-tiers') ||
    n === toast || n === pop ||
    [loadBtn, tierBtn, clearBtn, sortBtn, prefetchBtn].includes(n) ||
    (fallbackBar && n === fallbackBar);
  const observer = new MutationObserver((recs) => {
    if (loading) return;
    const relevant = recs.some((r) =>
      Array.from(r.addedNodes).some((n) => !isOurs(n)) || Array.from(r.removedNodes).some((n) => !isOurs(n)));
    if (!relevant) return;
    invalidateCards();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { ensureButtons(); observeTierCards(); scheduleEqualize(); }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  ensureButtons();
  observeTierCards();
  scheduleEqualize();

  // Reopening the page with a sort remembered: apply it to what's on the page (no auto-loading).
  async function autoRestore() {
    if (mode === 'default' || /^\/auction\//.test(location.pathname)) return;
    for (let i = 0; i < 10 && !getCards().length; i++) await sleep(300);
    if (!getCards().length) return;
    if (mode === 'cost_asc' && !tiersOn) setTiers(true);
    refreshTierObservers();
  }
  autoRestore();
  if (prefetchOn) setTimeout(prefetchTick, 4000);
})();