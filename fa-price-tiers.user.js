// ==UserScript==
// @name         Fur Affinity Price Tiers
// @namespace    https://www.furaffinity.net/
// @version      1.20
// @description  Price-tier chips under each Fur Affinity thumbnail (read from the submission's title + description), true-cost sort, "hide no price" filter, "Load more pages" button, auction-link chip
// @match        https://www.furaffinity.net/*
// @match        https://furaffinity.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// @author       Megoman16
// @homepageURL  https://github.com/Megoman16/YCH-Price-Tiers
// @supportURL   https://github.com/Megoman16/YCH-Price-Tiers/issues
// @updateURL    https://raw.githubusercontent.com/Megoman16/YCH-Price-Tiers/main/fa-price-tiers.user.js
// @downloadURL  https://raw.githubusercontent.com/Megoman16/YCH-Price-Tiers/main/fa-price-tiers.user.js
// ==/UserScript==

(function () {
  'use strict';
  if (window.__faTiersLoaded) return; // never run twice on the same page
  window.__faTiersLoaded = true;
  if (/^\/(view|full)\//.test(location.pathname)) return; // nothing to do on a submission page itself

  // ================= Config =================
  const TIERS_ON_KEY = 'fa-tiers-on';
  const MODE_KEY = 'fa-tiers-sort';
  const HIDE_KEY = 'fa-tiers-hide-noprice';
  const PAGES_KEY = 'fa-tiers-pages-per-load';
  const TIERS_CACHE_KEY = 'fa-tiers-cache-v2';
  try { localStorage.removeItem('fa-tiers-cache-v1'); } catch (e) {} // v1 didn't follow price-list links
  const TIER_CONCURRENCY = 4;       // most submissions read at the same time
  const TIER_GAP_MS = 250;          // pause before each worker starts its next read
  const AUCTION_TTL_H = 6;          // a live auction's bid is re-read after this many hours (ended ones keep the normal 3 days)
  const RAMP_AFTER = 15;            // after FA pushes back we drop to 1 at a time, then add one more every this many good reads
  const TIER_CACHE_DAYS = 3;        // FA descriptions get edited ("SOLD", new prices), so re-read after this
  const TIER_CACHE_MAX = 3000;
  const CACHE_SAVE_DELAY = 5000;
  const PAGES_DEFAULT = 1;          // starting value of the "Load [N] pages" box (it remembers what you type)
  const PAGES_MAX = 200;            // most pages one click may load
  const COUNT_LIMIT = 2048;         // "Count pages" stops looking past this page
  const PAGE_GAP_MS = 1500;
  const LINK_MAX = 2;                // most linked pages (price lists, journals, carrd, Google Docs...) read per submission
  // Links never worth reading for prices
  const LINK_SKIP_RE = /(^|\.)(twitter\.com|x\.com|bsky\.app|instagram\.com|t\.me|telegram\.(me|org)|discord\.(gg|com)|youtube\.com|youtu\.be|tiktok\.com|twitch\.tv|e621\.net|paypal\.(com|me)|ko-fi\.com|patreon\.com|boosty\.to)$/i;
  // Link text (or the line around it) that suggests a price list
  const LINK_HINT_RE = /price|pricing|rates?\b|\btos\b|terms|commission|\bcomms?\b|\bych\b|sheet|info|slots?\b|carrd|trello|docs\.google/i;
  const CHIPS_SHOWN = 6;            // more tiers than this collapse into "+N more" (hover shows every line)
  // Links to a ych.commishes / ych.art auction, with or without "https:" / "www." / "show/"
  const AUCTION_LINK_RE = /(?:https?:)?\/\/(?:www\.)?(?:ych\.commishes\.com\/auction\/(?:show\/)?[A-Za-z0-9_-]+|ych\.art\/auction\/\d+)/i;
  const FETCH_VERSION = 3; // submissions saved with no prices by an older version are read again once

  let tiersOn = true;
  try { tiersOn = (localStorage.getItem(TIERS_ON_KEY) || '1') === '1'; } catch (e) {}
  let mode = 'default'; // 'default' | 'cost_asc' | 'cost_desc'
  try { mode = localStorage.getItem(MODE_KEY) || 'default'; } catch (e) {}
  if (!/^(default|cost_asc|cost_desc)$/.test(mode)) mode = 'default';
  let hideNoPrice = false;
  try { hideNoPrice = localStorage.getItem(HIDE_KEY) === '1'; } catch (e) {}
  const HIDE_ENDED_KEY = 'fa-tiers-hide-ended';
  let hideEnded = false;
  try { hideEnded = localStorage.getItem(HIDE_ENDED_KEY) === '1'; } catch (e) {}

  let applying = false;
  let loading = false;
  let cancelled = false;
  let origCounter = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ================= Card helpers =================
  const isViewHref = (h) => /\/view\/\d+/.test(h || '');

  function cardOf(a) {
    const f = a.closest('figure');
    if (f) return f;
    let el = a;
    while (el.parentElement && el.parentElement.children.length === 1) el = el.parentElement;
    return el;
  }

  // Thumbnails: links to /view/<id>/ that sit in a <figure> or hold an image (plain text links are ignored).
  function getCards(root) {
    const live = !root;
    root = root || document;
    const seen = new Set();
    const cards = [];
    root.querySelectorAll('a[href*="/view/"]').forEach((a) => {
      if (!isViewHref(a.getAttribute('href'))) return;
      if (a.closest('.fa-tiers, #fa-tiers-bar')) return;
      if (!a.closest('figure') && !a.querySelector('img')) return;
      const el = cardOf(a);
      if (seen.has(el)) return;
      seen.add(el);
      if (live && el.dataset.faOrig === undefined) el.dataset.faOrig = String(origCounter++);
      cards.push(el);
    });
    return cards;
  }

  function cardId(card) {
    const a = Array.from(card.querySelectorAll('a[href*="/view/"]')).find((x) => isViewHref(x.getAttribute('href')));
    const m = a && a.getAttribute('href').match(/\/view\/(\d+)/);
    return m ? m[1] : null;
  }

  function cardTitle(card) {
    const a = card.querySelector('figcaption a[href*="/view/"]');
    if (a) return (a.getAttribute('title') || a.textContent || '').trim();
    const img = card.querySelector('img');
    return img ? (img.getAttribute('alt') || '').trim() : '';
  }

  // ================= Toast =================
  let toast = null, toastMsg = null, toastStop = null, toastAct = null;
  // action (optional): { label, fn } shows an extra button, e.g. "Retry now"
  function showToast(text, withStop, action) {
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:10px;background:rgba(30,30,30,.94);color:#fff;font:13px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      toastMsg = document.createElement('span');
      toastStop = document.createElement('button');
      toastStop.textContent = 'Stop';
      toastStop.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:5px 9px;background:#c0392b;color:#fff;font:inherit';
      toastStop.onclick = () => { cancelled = true; };
      toastAct = document.createElement('button');
      toastAct.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:5px 9px;background:#2a62c9;color:#fff;font:inherit';
      toast.append(toastMsg, toastAct, toastStop);
      document.body.appendChild(toast);
    }
    toastMsg.textContent = text;
    toastStop.style.display = withStop ? '' : 'none';
    toastAct.style.display = action ? '' : 'none';
    if (action) {
      toastAct.textContent = action.label;
      toastAct.onclick = () => { toast.style.display = 'none'; action.fn(); };
    }
    toast.style.display = 'flex';
  }
  let toastTimer = null;
  function hideToast(delay) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toast) toast.style.display = 'none'; }, delay || 0);
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

  // Modern theme: .submission-description. Classic theme / anything else: the smallest block holding the meta summary.
  function extractDescription(doc) {
    const el = doc.querySelector('.submission-description, #submission-description');
    if (el) return { text: nodeText(el), el: el };
    const metaEl = doc.querySelector('meta[property="og:description"]') || doc.querySelector('meta[name="description"]');
    const meta = metaEl ? (metaEl.getAttribute('content') || '') : '';
    const key = meta.replace(/(\.{3}|…)\s*$/, '').replace(/\s+/g, '').slice(0, 60);
    const best = key.length >= 8 ? smallestContaining(doc, key) : '';
    return { text: best.length >= meta.length ? best : meta, el: null };
  }

  // A ych.commishes / ych.art auction this submission points to, if any
  // Looks in the description first, then anywhere in the part of the page that was read (it stops before the
  // comments), in each link's address (also URL-encoded ones), its title and its text.
  function auctionLink(el, text, doc) {
    const fix = (u) => u.replace(/^\/\//, 'https://');
    for (const scope of [el, doc]) {
      if (!scope) continue;
      for (const a of scope.querySelectorAll('a[href]')) {
        let h = a.getAttribute('href') || '';
        try { h = decodeURIComponent(h); } catch (e) {}
        const m = h.match(AUCTION_LINK_RE) || (a.getAttribute('title') || '').match(AUCTION_LINK_RE) ||
          (a.textContent || '').match(AUCTION_LINK_RE);
        if (m) return fix(m[0]);
      }
    }
    const m = (text || '').match(AUCTION_LINK_RE);
    return m ? fix(m[0]) : null;
  }

  // ================= Linked price lists =================
  // Links in a description that might hold the prices: other FA submissions / journals, and outside pages
  // (carrd, Google Docs, ...). Each comes with whether its text or the line around it looks like a price list.
  function descLinks(el, text, selfId) {
    if (!el) return [];
    const lines = (text || '').split('\n');
    const out = [];
    el.querySelectorAll('a[href]').forEach((a) => {
      let u;
      try { u = new URL(a.getAttribute('href'), location.origin); } catch (e) { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      const host = u.hostname.replace(/^www\./, '');
      let url = null, kind = 'ext';
      if (/(^|\.)furaffinity\.net$/i.test(host)) {
        const m = u.pathname.match(/^\/(view|full|journal)\/(\d+)/);
        if (!m || m[2] === selfId) return;
        kind = m[1] === 'journal' ? 'journal' : 'view';
        url = location.origin + '/' + kind + '/' + m[2] + '/';
      } else {
        if (LINK_SKIP_RE.test(host) || AUCTION_LINK_RE.test(u.href)) return;
        const gd = u.href.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
        url = gd ? 'https://docs.google.com/document/d/' + gd[1] + '/export?format=txt' : u.href;
        if (gd) kind = 'gdoc';
      }
      if (out.some((o) => o.url === url)) return;
      const lt = (a.textContent || '').trim();
      const i = lt ? lines.findIndex((l) => l.includes(lt)) : -1;
      const around = i >= 0 ? (lines[i - 1] || '') + ' ' + lines[i] : '';
      out.push({ url: url, open: u.href, kind: kind, host: host, hint: LINK_HINT_RE.test(lt + ' ' + around + ' ' + u.href) });
    });
    return out;
  }

  // Outside sites need the userscript manager's cross-site request (FA pages use a normal fetch)
  function gmGet(url) {
    return new Promise((resolve) => {
      const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
      if (!gm) return resolve(null);
      try {
        gm({ method: 'GET', url: url, timeout: 15000,
          onload: (r) => resolve(r.status >= 200 && r.status < 300 ? r.responseText : null),
          onerror: () => resolve(null), ontimeout: () => resolve(null) });
      } catch (e) { resolve(null); }
    });
  }

  // Many submissions link the same price list, so each linked page is read once per visit.
  const linkedMemo = new Map();
  function readLinked(l) {
    if (linkedMemo.has(l.url)) return linkedMemo.get(l.url);
    const p = (async () => {
      await sleep(TIER_GAP_MS);
      if (Date.now() < tierPausedUntil) { linkedMemo.delete(l.url); return null; }
      try {
        let html;
        if (l.kind === 'ext' || l.kind === 'gdoc') {
          html = await gmGet(l.url);
          if (html === null) return null;
          if (l.kind === 'gdoc') return { title: 'Google Doc', text: html.slice(0, DESC_KEEP) };
        } else {
          const res = await fetch(l.url, { credentials: 'same-origin', priority: 'low' });
          if (res.status === 429 || res.status === 503 || res.status === 403) {
            tierPausedUntil = Math.max(tierPausedUntil, Date.now() + 30000);
            tierLimit = 1;
            linkedMemo.delete(l.url);
            return null;
          }
          if (!res.ok) return null;
          html = await res.text();
        }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let text = '', title = l.host;
        if (l.kind === 'ext') {
          doc.querySelectorAll('script,style,noscript,svg,nav,header,footer').forEach((e) => e.remove());
          text = doc.body ? nodeText(doc.body) : '';
        } else {
          const j = doc.querySelector('.journal-content, .journal-body, #journal-content');
          text = j ? nodeText(j) : extractDescription(doc).text;
          const og = doc.querySelector('meta[property="og:title"]');
          title = ((og && og.getAttribute('content')) || doc.title || '').split(' -- ')[0];
          const by = title.lastIndexOf(' by ');
          if (by > 0) title = title.slice(0, by);
        }
        return { title: title.trim(), text: text.replace(/\n{3,}/g, '\n\n').slice(0, DESC_KEEP) };
      } catch (e) { return null; }
    })();
    linkedMemo.set(l.url, p);
    return p;
  }

  // ---- Linked ych.commishes / ych.art auctions: read their description (tiers) and current price ----
  const BID_RES = [
    /Auction Price\s*[:\-]?\s*\$\s?([\d,]+(?:\.\d+)?)/i,
    /(?:current|highest|top)\s+(?:bid|price)\s*[:\-]?\s*\$\s?([\d,]+(?:\.\d+)?)/i
  ];
  // The auction site's description: the block holding its meta summary, or else everything after the <h1>
  function auctionDescription(doc) {
    const a = extractDescription(doc).text;
    let b = '';
    const h1 = doc.querySelector('h1');
    if (h1) {
      const parts = [];
      let n = h1.nextSibling;
      for (let g = 0; n && g < 50; g++, n = n.nextSibling) {
        if (n.nodeType === 1 && /^H[1-6]$/.test(n.tagName)) break;
        parts.push(n.nodeType === 3 ? n.textContent : (n.nodeType === 1 ? nodeText(n) : ''));
      }
      b = parts.join('\n').split(/Samples\s+These are examples/i)[0];
    }
    return a.trim().length >= 8 ? a : b;
  }
  // "Auction ended", "This auction has ended", "Auction closed"...
  const AUCTION_ENDED_RE = /\bauction\s+(?:has\s+)?(?:ended|closed|finished|is\s+over)\b/i;
  // An ended auction (or one shown as a list of bids) has no "Auction Price" line: find the box that holds
  // "Started at $1.00" together with the bids ("DarkScar $60.00", ...) and take the highest amount in it.
  function bidFromList(doc) {
    if (!doc.body) return null;
    const amounts = (t) => Array.from(t.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)).map((m) => parseFloat(m[1].replace(/,/g, '')));
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (!/start(?:ed|ing)/i.test(n.textContent)) continue;
      // "Started at" and "$1.00" may sit in separate tags: climb until both are in one element
      const START_RE = /start(?:ed|ing)\s*(?:at|bid|price)?\s*:?\s*\$\s?\d/i;
      let host = n.parentElement;
      for (let k = 0; host && k < 3 && !START_RE.test((host.textContent || '').replace(/\s+/g, ' ')); k++) host = host.parentElement;
      if (!host || !START_RE.test((host.textContent || '').replace(/\s+/g, ' '))) continue;
      const start = amounts(host.textContent.replace(/[\s\S]*?start(?:ed|ing)/i, ''))[0];
      let el = host;
      for (let up = 0; el && el !== doc.body && up < 8; up++, el = el.parentElement) {
        const t = el.textContent || '';
        if (t.length > 2500) break;            // grew past the bids box
        if (/no\s+bids/i.test(t)) return start || null;   // "No bids yet": the starting price is the price
        // Buy-now / autobuy prices aren't bids
        const a = amounts(t.replace(/(?:buy\s*now|auto-?\s?buy|\bAB\b)\s*:?\s*\$\s?[\d,]+(?:\.\d+)?/gi, ' '));
        if (a.length >= 2) return Math.max.apply(null, a);
      }
      return start || null;                    // no bids: the starting price is the price
    }
    return null;
  }
  // Ended = a visible "Auction ended" AND no sign the auction is still running. The page carries a hidden
  // "Auction ended" message for when the countdown runs out, so the text alone isn't enough.
  const isHiddenEl = (el) => {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') || '')) return true;
      if (/(?:^|\s)(?:d-none|hidden|is-hidden|invisible|collapse)(?:\s|$)/.test(el.getAttribute('class') || '')) return true;
    }
    return false;
  };
  // The bid box: the element around "Started at $X" (it also holds the bids, the countdown and, once it's over,
  // "Auction ended"). null when the page as downloaded doesn't have one (e.g. the site draws it with JavaScript).
  function bidBox(doc) {
    if (!doc.body) return null;
    const START_RE = /start(?:ed|ing)\s*(?:at|bid|price)?\s*:?\s*\$\s?\d/i;
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (!/start(?:ed|ing)/i.test(n.textContent)) continue;
      let el = n.parentElement;
      for (let k = 0; el && k < 3 && !START_RE.test((el.textContent || '').replace(/\s+/g, ' ')); k++) el = el.parentElement;
      if (!el || !START_RE.test((el.textContent || '').replace(/\s+/g, ' '))) continue;
      // widen while it stays box-sized, to take in the header ("Auction ended" / the countdown) and the bids
      for (let up = 0; up < 6 && el.parentElement && el.parentElement !== doc.body; up++) {
        if ((el.parentElement.textContent || '').length > 1500) break;
        el = el.parentElement;
      }
      return el;
    }
    return null;
  }

  // Only says "ended" when it's sure: "Auction ended" must be inside the bid box, and nothing there may say the
  // auction is still running. No bid box in the page = can't tell = not marked ended.
  function auctionEnded(doc) {
    const box = bidBox(doc);
    if (!box) return false;
    doc = { body: box, createTreeWalker: (root, what) => box.ownerDocument.createTreeWalker(box, what),
      querySelectorAll: (q) => box.querySelectorAll(q) };
    let endedShown = false, running = false;
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.textContent.trim();
      if (!t || isHiddenEl(n.parentElement)) continue;
      if (AUCTION_ENDED_RE.test(t)) endedShown = true;
      // Still running: a countdown ("23:47:49", "2d 4h"), "No bids yet. Be the first!", a Bid / Buy now button
      if (/^\d{1,3}\s*:\s*\d{2}\s*:\s*\d{2}$/.test(t) || /^(?:\d+\s*d\s*)?\d+\s*h(?:\s*\d+\s*m)?$/i.test(t) ||
          /be the first|time left|ends in/i.test(t) ||
          (/^(?:place\s+)?bid$|^buy\s*now\b/i.test(t) && n.parentElement.closest('button, a, input, [role="button"]'))) running = true;
    }
    doc.querySelectorAll('input[type="submit"], input[type="button"]').forEach((i) => {
      if (/^(?:place\s+)?bid$|^buy\s*now\b/i.test((i.value || '').trim()) && !isHiddenEl(i)) running = true;
    });
    return endedShown && !running;
  }
  const auctionMemo = new Map();
  function readAuction(url) {
    if (auctionMemo.has(url)) return auctionMemo.get(url);
    const p = (async () => {
      const html = await gmGet(url);
      if (html === null) { auctionMemo.delete(url); return null; }
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // ych.commishes keeps the end time on the auction box: <div id="auction" data-endtime="1795566128"> (unix seconds).
      // The site's own code shows the bid form or "Auction ended" from it, and both are in the page, so the
      // end time is what decides.
      const endEl = doc.querySelector('[data-endtime], [data-end-time], [data-end]');
      const endRaw = endEl ? parseFloat(endEl.getAttribute('data-endtime') || endEl.getAttribute('data-end-time') || endEl.getAttribute('data-end')) : NaN;
      const endAt = endRaw > 1e9 ? (endRaw < 1e12 ? endRaw * 1000 : endRaw) : null; // seconds or milliseconds
      doc.querySelectorAll('script,style,noscript,template').forEach((e) => e.remove());
      const body = (doc.body && doc.body.textContent) || '';
      let bid = null;
      for (const re of BID_RES) {
        const m = body.match(re);
        if (m) { bid = parseFloat(m[1].replace(/,/g, '')); break; }
      }
      if (bid === null) bid = bidFromList(doc);
      return { text: auctionDescription(doc).replace(/\n{3,}/g, '\n\n').slice(0, DESC_KEEP), bid: bid,
        endAt: endAt, ended: endAt ? endAt <= Date.now() : auctionEnded(doc) };
    })();
    auctionMemo.set(url, p);
    return p;
  }

  // ================= Raffles / giveaways =================
  const RAFFLE_RE = /\b(?:raffle|giveaway|give-away|giveway)s?\b/i;
  const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  // "winner will be determined on December 20", "ends Dec 5th", "draw: 20 December"
  const DRAW_RE = new RegExp('(?:winner|draw|drawn|ends?|ending|chosen|announced|determined|picked|closes?|until|till)[^\n.!]{0,40}?\\b((?:' + MONTHS + ')\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:' + MONTHS + ')\\b\\.?)', 'i');
  function drawDate(text) {
    const m = (text || '').match(DRAW_RE);
    if (!m) return null;
    const label = m[1].replace(/\s+/g, ' ').trim();
    const clean = label.replace(/(\d)(st|nd|rd|th)/i, '$1').replace(/\bof\b/i, '').replace(/\./g, '');
    const now = new Date();
    let t = Date.parse(clean + ' ' + now.getFullYear());
    if (isNaN(t)) return { label: label, at: null };
    if (t < Date.now() - 60 * 864e5) t = Date.parse(clean + ' ' + (now.getFullYear() + 1)); // "January 5" posted in December
    return { label: label, at: t + 864e5 - 1 }; // end of that day
  }

  // The raffle's post: an X / Twitter status or a Bluesky post, from the description's links or text
  const X_POST_RE = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i;
  const BSKY_POST_RE = /(?:https?:\/\/)?bsky\.app\/profile\/([^/\s]+)\/post\/([a-z0-9]+)/i;
  function socialPost(el, text, doc) {
    const hay = [];
    for (const scope of [el, doc]) {
      if (!scope) continue;
      scope.querySelectorAll('a[href]').forEach((a) => {
        let h = a.getAttribute('href') || '';
        try { h = decodeURIComponent(h); } catch (e) {}
        hay.push(h, a.textContent || '');
      });
    }
    hay.push(text || '');
    for (const h of hay) {
      let m = h.match(X_POST_RE);
      if (m) return { kind: 'x', user: m[1], id: m[2], url: 'https://x.com/' + m[1] + '/status/' + m[2] };
      m = h.match(BSKY_POST_RE);
      if (m) return { kind: 'bsky', user: m[1], id: m[2], url: 'https://bsky.app/profile/' + m[1] + '/post/' + m[2] };
    }
    return null;
  }

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? +v : null));
  async function gmJson(url) {
    const t = await gmGet(url);
    if (t === null) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }
  // Likes / reposts / replies + text. X: FxTwitter's public API (no account needed), then X's own embed feed.
  // Bluesky: its public API.
  async function readSocial(p) {
    try {
      if (p.kind === 'x') {
        let j = await gmJson('https://api.fxtwitter.com/2/status/' + p.id);
        let st = j && (j.status || j.tweet);
        if (!st) { j = await gmJson('https://api.fxtwitter.com/status/' + p.id); st = j && (j.tweet || j.status); }
        if (st) {
          return { text: st.text || (st.raw_text && st.raw_text.text) || '', likes: num(st.likes), reposts: num(st.reposts != null ? st.reposts : st.retweets),
            replies: num(st.replies), views: num(st.views) };
        }
        j = await gmJson('https://cdn.syndication.twimg.com/tweet-result?id=' + p.id + '&lang=en&token=' + ((Number(p.id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''));
        if (j && (j.text || j.favorite_count != null)) {
          return { text: j.text || '', likes: num(j.favorite_count), reposts: num(j.retweet_count), replies: num(j.conversation_count), views: null };
        }
        return null;
      }
      let did = p.user;
      if (!/^did:/.test(did)) {
        const r = await gmJson('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=' + encodeURIComponent(p.user));
        if (!r || !r.did) return null;
        did = r.did;
      }
      const j = await gmJson('https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=' +
        encodeURIComponent('at://' + did + '/app.bsky.feed.post/' + p.id));
      const post = j && j.posts && j.posts[0];
      if (!post) return null;
      return { text: (post.record && post.record.text) || '', likes: num(post.likeCount), reposts: num(post.repostCount),
        replies: num(post.replyCount), views: null };
    } catch (e) { return null; }
  }

  // "True cost": the higher of the most expensive tier (top of a range counts; add-ons and AB-only tiers don't)
  // and a linked auction's current price. null = no prices found.
  function trueCost(tiers, bid) {
    const c = Math.max(tiers.filter((t) => !t.add && !t.ab).reduce((m, t) => Math.max(m, t.hi || t.p), 0), bid || 0);
    return c > 0 ? c : null;
  }

  // ================= Tier cache =================
  // Each entry keeps the title + description text (d), so when the tier reader gets smarter
  // (PARSER_VERSION goes up) saved submissions are re-read from that text with no request to FA.
  const PARSER_VERSION = 6;
  const DESC_KEEP = 3000;
  let tierCache = {};
  // Saved in Tampermonkey's own storage (no ~5 MB per-site limit like localStorage). Older versions used
  // localStorage: that copy is moved over on first run.
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  function readStore() {
    let raw = null;
    if (hasGM) { try { raw = GM_getValue(TIERS_CACHE_KEY, null); } catch (e) {} }
    if (!raw) { try { raw = localStorage.getItem(TIERS_CACHE_KEY); } catch (e) {} }
    return raw;
  }
  function writeStore(str) {
    if (hasGM) {
      GM_setValue(TIERS_CACHE_KEY, str);
      try { localStorage.removeItem(TIERS_CACHE_KEY); } catch (e) {} // moved: free the site's storage
    } else localStorage.setItem(TIERS_CACHE_KEY, str);
  }
  function clearStore() {
    if (hasGM) { try { GM_setValue(TIERS_CACHE_KEY, '{}'); } catch (e) {} }
    try { localStorage.removeItem(TIERS_CACHE_KEY); } catch (e) {}
  }
  try { tierCache = JSON.parse(readStore() || '{}'); } catch (e) { tierCache = {}; }
  let saveTimer = null;
  let cacheDirty = false;
  const isLive = (v, now) => !!v && v.t > now - (v.ttl || TIER_CACHE_DAYS * 864e5);

  function writeCache() {
    clearTimeout(saveTimer);
    if (!cacheDirty) return;
    cacheDirty = false;
    const now = Date.now();
    let entries = Object.entries(tierCache).filter(([, v]) => isLive(v, now));
    entries.sort((a, b) => b[1].t - a[1].t);
    if (entries.length > TIER_CACHE_MAX) entries = entries.slice(0, TIER_CACHE_MAX);
    // Storage full: drop the oldest quarter and try again, until it fits
    for (let attempt = 0; attempt < 12 && entries.length; attempt++) {
      try {
        tierCache = Object.fromEntries(entries);
        writeStore(JSON.stringify(tierCache));
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
  window.addEventListener('pagehide', writeCache);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeCache(); });

  function cachedTiers(id) {
    const v = tierCache[id];
    if (!isLive(v, Date.now())) return null;
    if (v.ln && v.av !== 5) return null; // saved before bids / ended auctions were read properly: read it again
    if (v.fv !== FETCH_VERSION && !(v.tiers || []).length && !v.bid) return null; // no prices found by an older version
    if (v.pv !== PARSER_VERSION && typeof v.d === 'string') {
      v.tiers = parseTiers(v.d);
      v.pv = PARSER_VERSION;
      saveCache();
    }
    return v;
  }

  // ================= Rendering =================
  // Inline styles only (FA's CSP can block injected <style> elements)
  const CSS = {
    // width:0 + min-width:100% keeps the chips from making the thumbnail wider than its picture
    // all:initial first: FA's gallery CSS styles <b>, <span> etc. inside thumbnails and was leaking into the chips
    box: 'all:initial;display:block;flex:0 0 100%;order:99;position:static;float:none;width:0;min-width:100%;height:auto;box-sizing:border-box;margin:4px 0 0;padding:4px 5px 5px;border-radius:6px;background:rgba(127,127,127,.14);color:inherit;text-align:left;font:11px/16px system-ui,sans-serif;cursor:help',
    row: 'all:initial;display:flex;flex-wrap:wrap;gap:3px;margin:2px 0;color:inherit;font:11px/16px system-ui,sans-serif',
    head: 'all:initial;display:block;margin:4px 0 0;color:inherit;opacity:.75;font:700 10px/14px system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
    chip: 'all:initial;display:inline-flex;align-items:baseline;gap:4px;max-width:100%;box-sizing:border-box;padding:0 6px;border-radius:9px;background:#3a4a6b;color:#fff;border:1px solid rgba(255,255,255,.25);font:11px/16px system-ui,sans-serif;white-space:normal;text-align:left;text-decoration:none;cursor:inherit',
    add: 'background:#5f5f5f',
    ab: 'background:#2a62c9',
    cost: 'background:#b36b00',
    link: 'background:#1f7a46;cursor:pointer',
    bid: 'background:#2e7d32',
    ended: 'background:#8e1b1b',
    ends: 'background:#5a5a8a',
    raffle: 'background:#0f7c8c;cursor:pointer',
    stats: 'background:#33414f',
    plist: 'background:#6b3fa0;cursor:pointer',
    none: 'background:transparent;color:inherit;border-color:rgba(127,127,127,.5);opacity:.75',
    more: 'background:transparent;color:inherit;border-color:rgba(127,127,127,.5)',
    pop: 'position:fixed;z-index:2147483647;display:none;pointer-events:none;max-width:min(420px,92vw);box-sizing:border-box;background:#222;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.5);padding:6px 10px;font:12px/1.4 system-ui,sans-serif;text-align:left',
    b: 'all:initial;display:inline;color:inherit;font:700 11px/16px system-ui,sans-serif;white-space:nowrap',
    lbl: 'all:initial;display:inline;min-width:0;color:inherit;font:400 11px/16px system-ui,sans-serif;overflow-wrap:anywhere'
  };

  const fmtPrice = (p) => '$' + (Number.isInteger(p) ? p : p.toFixed(2));

  function makeChip(strong, label, extraCss, tag) {
    const chip = document.createElement(tag || 'span');
    chip.style.cssText = CSS.chip + (extraCss ? ';' + extraCss : '');
    const b = document.createElement('span');
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

  // FA positions the caption over the bottom of the thumbnail box; once the box grows, the caption sat on top of
  // the chips. Put the caption back in the normal flow, and if anything still overlaps, push the chips down.
  function fixOverlap(card, box) {
    if (!box.isConnected) return;
    const fc = card.querySelector('figcaption');
    const cs = getComputedStyle(card);
    if (/flex/.test(cs.display) && !/column/.test(cs.flexDirection)) card.style.setProperty('flex-wrap', 'wrap', 'important');
    if (!fc) return;
    if (/absolute|fixed/.test(getComputedStyle(fc).position)) {
      fc.style.setProperty('position', 'static', 'important');
      fc.style.setProperty('transform', 'none', 'important');
    }
    box.style.setProperty('margin-top', '4px', 'important');
    const fr = fc.getBoundingClientRect(), br = box.getBoundingClientRect();
    const overlapX = Math.min(fr.right, br.right) - Math.max(fr.left, br.left) > 2;
    if (overlapX && fr.bottom > br.top && fr.top < br.bottom) {
      box.style.setProperty('margin-top', Math.ceil(fr.bottom - br.top + 4) + 'px', 'important');
    }
  }

  // A title marked "[CLOSED]", "(SOLD)", "【TAKEN】"... counts as ended too
  const TITLE_CLOSED_RE = /[\[(【{]\s*(?:closed|sold|taken|finished|ended|over)\s*[\])】}]/i;

  // 6409 -> "6.4k", 1250000 -> "1.3M"
  function fmtCount(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return (n < 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1e3)) + 'k';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  function timeLeftText(ms) {
    const m = Math.max(0, Math.round(ms / 6e4));
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  function applyHide(card) {
    if ((hideNoPrice && card._faCost === null) || (hideEnded && card._faEnded)) card.style.setProperty('display', 'none', 'important');
    else card.style.removeProperty('display');
  }

  function renderCard(card, entry) {
    applying = true;
    try {
      card.querySelectorAll('.fa-tiers').forEach((e) => e.remove());
      const tiers = (entry && entry.tiers) || [];
      const rf = entry && entry.rf;
      card._faCost = trueCost(tiers, entry && entry.bid);
      if (card._faCost === null && rf) card._faCost = 0; // free to enter: sorts as $0, never hidden as "no price"
      card._faEnded = !!(entry && (entry.end || (entry.endAt && entry.endAt <= Date.now()) || (rf && rf.drawAt && rf.drawAt < Date.now()))) ||
        TITLE_CLOSED_RE.test(cardTitle(card));

      const box = document.createElement('div');
      box.className = 'fa-tiers';
      box.style.cssText = CSS.box + (tiersOn ? '' : ';display:none');

      const top = document.createElement('div');
      top.style.cssText = CSS.row;
      if (card._faCost) top.appendChild(makeChip(fmtPrice(card._faCost), 'true cost', CSS.cost));
      else if (rf) top.appendChild(makeChip('Free', 'raffle', CSS.cost));
      else top.appendChild(makeChip('no prices found', '', CSS.none));
      let rfRow = null;
      if (rf) {
        const rc = makeChip('Raffle' + (rf.url ? ' ↗' : ''), rf.site ? 'on ' + rf.site : '', CSS.raffle, rf.url ? 'a' : 'span');
        if (rf.url) { rc.href = rf.url; rc.target = '_blank'; rc.rel = 'noopener noreferrer'; rc.title = rf.url; }
        top.appendChild(rc);
        if (rf.draw && !card._faEnded) top.appendChild(makeChip('Draw', rf.draw, CSS.ends));
        // One labelled chip per number ("439 likes"), plain words instead of emoji (which some fonts draw as boxes)
        const stats = [['likes', rf.likes], ['reposts', rf.reposts], ['replies', rf.replies], ['views', rf.views]]
          .filter(([, v]) => v != null);
        if (stats.length) {
          const row = document.createElement('div');
          row.style.cssText = CSS.row;
          stats.forEach(([k, v]) => row.appendChild(makeChip(fmtCount(v), k, CSS.stats)));
          rfRow = row;
        } else if (rf.url && !rf.read) top.appendChild(makeChip('stats unavailable', '', CSS.none));
      }
      if (card._faEnded) top.appendChild(makeChip('Ended', '', CSS.ended));
      else if (entry && entry.endAt) top.appendChild(makeChip('Ends in', timeLeftText(entry.endAt - Date.now()), CSS.ends));
      if (entry && entry.bid) top.appendChild(makeChip(entry.end ? 'Final bid' : 'Bid', fmtPrice(entry.bid), CSS.bid));
      if (entry && entry.ln) {
        const a = makeChip('Auction ↗', '', CSS.link, 'a');
        a.href = entry.ln;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = entry.ln;
        top.appendChild(a);
      }
      if (entry && entry.pl && !tiers.length) {
        // A price list we couldn't read (an image, or a site that needs JavaScript): at least link to it
        const a = makeChip('Price list ↗', '', CSS.plist, 'a');
        a.href = entry.pl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = entry.pl;
        top.appendChild(a);
      }
      box.appendChild(top);
      if (rfRow) box.appendChild(rfRow);

      // Tier chips, grouped by section, up to CHIPS_SHOWN of them
      let shown = 0, lastSection = null, row = null;
      tiers.forEach((t) => {
        if (shown >= CHIPS_SHOWN) return;
        if (t.section !== lastSection || !row) {
          if (t.section) {
            const h = document.createElement('div');
            h.style.cssText = CSS.head;
            h.textContent = t.section;
            box.appendChild(h);
          }
          row = document.createElement('div');
          row.style.cssText = CSS.row;
          box.appendChild(row);
          lastSection = t.section;
        }
        row.appendChild(makeChip(
          (t.add ? '+' : '') + fmtPrice(t.p) + (t.hi ? '–' + fmtPrice(t.hi) : '') + (t.plus ? '+' : ''),
          t.label,
          t.add ? CSS.add : (t.ab ? CSS.ab : '')
        ));
        shown++;
      });
      if (tiers.length > shown && row) row.appendChild(makeChip('+' + (tiers.length - shown) + ' more', '', CSS.more));

      box._lines = Array.from(new Set(tiers.map((t) => t.line.replace(/\s+/g, ' ').trim())));
      if (rf && rf.text) box._lines.unshift((rf.site || 'Raffle') + ' post: ' + rf.text);
      box.addEventListener('mouseenter', () => showPop(box));
      box.addEventListener('mouseleave', hidePop);

      // Let the thumbnail grow so the chips show in full
      card.style.setProperty('height', 'auto', 'important');
      card.style.setProperty('max-height', 'none', 'important');
      card.style.setProperty('overflow', 'visible', 'important');
      card.appendChild(box);
      requestAnimationFrame(() => fixOverlap(card, box));
      setTimeout(() => fixOverlap(card, box), 700); // thumbnails may finish loading and shift things
      applyHide(card);
      scheduleSort();
    } finally {
      setTimeout(() => { applying = false; }, 100);
    }
  }

  // ================= Sorting =================
  // Priced first (by true cost), then "no prices found", then not read yet. Ties keep FA's order.
  function applySort() {
    applying = true;
    try {
      const groups = new Map();
      getCards().forEach((c) => {
        const p = c.parentElement;
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(c);
      });
      const rank = (c) => c._faCost === undefined ? 2 : (c._faCost === null ? 1 : 0);
      const dir = mode === 'cost_desc' ? -1 : 1;
      groups.forEach((items, parent) => {
        if (items.length < 2) return;
        const sorted = items.slice().sort((a, b) => {
          if (mode !== 'default') {
            const ra = rank(a), rb = rank(b);
            if (ra !== rb) return ra - rb;
            if (ra === 0 && a._faCost !== b._faCost) return dir * (a._faCost - b._faCost);
          }
          return Number(a.dataset.faOrig) - Number(b.dataset.faOrig);
        });
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

  // While tiers are still being read, re-sort at most every ~1.5s so thumbnails don't jump constantly.
  let sortTimer = null;
  function scheduleSort() {
    if (mode === 'default') return;
    clearTimeout(sortTimer);
    sortTimer = setTimeout(applySort, 1500);
  }

  // ================= Tier fetching (lazy, only thumbnails near the screen; all of them when sorting) =================
  const tierQueue = [];
  let tierActive = 0;
  let tierPausedUntil = 0;
  let tierBackoff = 0;
  let pumpTimer = null;
  let tierLimit = TIER_CONCURRENCY; // drops to 1 when FA pushes back, then climbs again
  let tierGood = 0;

  async function fetchTiers(card) {
    const id = cardId(card);
    try {
      const res = await fetch('/view/' + id + '/', { credentials: 'same-origin', priority: 'low' });
      if (res.status === 429 || res.status === 503 || res.status === 403) {
        // FA (or Cloudflare) is asking us to slow down: pause everything and retry this one later.
        tierBackoff = Math.min(tierBackoff + 1, 5);
        tierLimit = 1;                // come back slowly
        tierGood = 0;
        const secs = 30 * Math.pow(2, tierBackoff - 1);
        tierPausedUntil = Date.now() + secs * 1000;
        showToast('FA asked to slow down. Price reading paused for ' + secs + 's, then 1 at a time', false,
          { label: 'Retry now', fn: retryPrices });
        hideToast(Math.min(secs * 1000, 15000));
        tierQueue.unshift(card);
        return;
      }
      if (!res.ok) throw new Error('http ' + res.status);
      tierBackoff = 0;
      if (tierLimit < TIER_CONCURRENCY && ++tierGood >= RAMP_AFTER) { tierLimit++; tierGood = 0; }
      let partial = await readUntilComments(res);
      let doc = new DOMParser().parseFromString(partial.html, 'text/html');
      let desc = extractDescription(doc);
      if (!desc.el && partial.cut) {
        // Cut short but the description wasn't found in the part we read: fetch the whole page after all
        const full = await fetch('/view/' + id + '/', { credentials: 'same-origin', priority: 'low' });
        doc = new DOMParser().parseFromString(await full.text(), 'text/html');
        desc = extractDescription(doc);
      }
      let d = (cardTitle(card) + '\n' + desc.text).slice(0, DESC_KEEP);
      // No prices here? Read the linked price list(s). Prices here? Only links that look like a price list.
      // A linked ych.commishes / ych.art auction is where the real prices are: read its description and current bid
      const ln = auctionLink(desc.el, desc.text, doc);
      // Raffle / giveaway: no price, but show the draw date and the post's likes / reposts / replies
      let rf = null;
      if (RAFFLE_RE.test(cardTitle(card) + '\n' + desc.text)) {
        const sp = socialPost(desc.el, desc.text, doc);
        const so = sp ? await readSocial(sp) : null;
        const dd = drawDate((so && so.text) || '') || drawDate(desc.text);
        rf = { url: sp ? sp.url : null, site: sp ? (sp.kind === 'x' ? 'X' : 'Bluesky') : null, read: !!so,
          likes: so ? so.likes : null, reposts: so ? so.reposts : null, replies: so ? so.replies : null, views: so ? so.views : null,
          draw: dd ? dd.label : null, drawAt: dd ? dd.at : null,
          text: so ? so.text.replace(/\s*\n\s*/g, ' / ').slice(0, 400) : null };
      }
      let bid = null, ended = false, endAt = null, auRead = !ln;
      if (ln) {
        const au = await readAuction(ln);
        if (au) {
          auRead = true;
          bid = au.bid;
          ended = au.ended;
          endAt = au.endAt;
          if (au.text.trim()) d += '\n\nAuction - ' + new URL(ln).hostname.replace(/^www\./, '') + ':\n' + au.text;
        }
      }
      const hasOwn = parseTiers(d).length > 0 || !!bid;
      let links = descLinks(desc.el, desc.text, id);
      links = hasOwn ? links.filter((l) => l.hint) : links.sort((a, b) => b.hint - a.hint);
      links = links.slice(0, LINK_MAX);
      for (const l of links) {
        const got = await readLinked(l);
        if (!got || !got.text.trim()) continue;
        // Becomes a section header, so the linked tiers are grouped under it
        const name = (got.title || l.host).replace(/[$€£:：]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
        d += '\n\nLinked - ' + name + ':\n' + got.text;
      }
      if (Date.now() < tierPausedUntil && links.length) {
        // FA pushed back while reading a linked price list: try this submission again later rather than
        // saving it without those prices
        tierQueue.push(card);
        return;
      }
      const tiers = parseTiers(d);
      const hinted = links.find((l) => l.hint) || (!tiers.length && links[0]);
      const entry = { t: Date.now(), d: d, pv: PARSER_VERSION, tiers: tiers, ln: ln, fv: FETCH_VERSION, av: auRead ? 5 : 0, bid: bid, end: ended ? 1 : 0,
        endAt: endAt,
        rf: rf,
        // live auction: re-read its bid sooner, and right after it ends to get the final bid
        ttl: rf && rf.url && !(rf.drawAt && rf.drawAt < Date.now()) ? AUCTION_TTL_H * 36e5 : ln && auRead && !ended ? Math.max(6e4, Math.min(AUCTION_TTL_H * 36e5, endAt ? endAt - Date.now() + 6e4 : Infinity)) : 0,
        // av 0: auction couldn't be read, try again next visit
       
        pl: hinted ? hinted.open : null };
      if (id) { tierCache[id] = entry; saveCache(); }
      renderCard(card, entry);
    } catch (e) { card.dataset.faFailed = '1'; /* leave the thumbnail as is; "Retry prices" tries it again */ }
    if (mode !== 'default') {
      const left = tierQueue.length;
      showToast(left ? 'Sorting: ' + left + ' submissions left to read' : 'Sorting complete', false);
      if (!left) { hideToast(2000); clearTimeout(sortTimer); applySort(); }
    }
    if (!tierQueue.includes(card)) card.dataset.faDone = '1';
  }

  // A submission page is mostly comments, which come after the description: stop downloading there.
  const COMMENTS_MARK_RE = /id=["']comments-submission["']|class=["'][^"']*\bcomments-list\b|class=["'][^"']*\bsubmission-comments\b/;
  async function readUntilComments(res) {
    if (!res.body || !res.body.getReader) return { html: await res.text(), cut: false };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { html: html + dec.decode(), cut: false };
      html += dec.decode(value, { stream: true });
      const m = html.search(COMMENTS_MARK_RE);
      if (m > 0 && /submission-description/.test(html.slice(0, m))) {
        try { reader.cancel(); } catch (e) {}
        return { html: html.slice(0, m), cut: true };
      }
    }
  }

  // Thumbnails on screen are read before the rest of the queue
  function nextQueued() {
    const vh = window.innerHeight;
    for (let i = 0; i < tierQueue.length && i < 400; i++) {
      const r = tierQueue[i].getBoundingClientRect();
      if (r.bottom > -100 && r.top < vh + 100 && r.width) return tierQueue.splice(i, 1)[0];
    }
    return tierQueue.shift();
  }

  function pumpTiers() {
    const wait = tierPausedUntil - Date.now();
    if (wait > 0) {
      if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pumpTiers(); }, wait + 100);
      return;
    }
    while (tiersOn && !loading && tierActive < tierLimit && tierQueue.length) {
      const card = nextQueued();
      tierActive++;
      fetchTiers(card).finally(() => {
        tierActive--;
        setTimeout(pumpTiers, TIER_GAP_MS);
      });
    }
  }

  function enqueueTiers(card) {
    if (card.dataset.faDone || card.dataset.faQ) return;
    const id = cardId(card);
    if (!id) return;
    const hit = cachedTiers(id);
    if (hit) { renderCard(card, hit); card.dataset.faDone = '1'; return; }
    card.dataset.faQ = '1';
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

  // Saved tiers need no request, so draw them for every thumbnail straight away, a batch per frame.
  const cachedPending = [];
  let cachedRaf = 0;
  function renderCachedNow(cards) {
    cards.forEach((c) => {
      if (c.dataset.faDone || c.dataset.faQ) return;
      const id = cardId(c);
      if (id && cachedTiers(id)) cachedPending.push(c);
    });
    if (!cachedRaf && cachedPending.length) cachedRaf = requestAnimationFrame(drainCached);
  }
  function drainCached() {
    cachedRaf = 0;
    cachedPending.splice(0, 30).forEach((c) => { if (c.isConnected && !c.dataset.faDone) enqueueTiers(c); });
    if (cachedPending.length) cachedRaf = requestAnimationFrame(drainCached);
  }

  function observeTierCards() {
    if (!tiersOn) return;
    const cards = getCards();
    renderCachedNow(cards);
    if (mode !== 'default' && !loading) cards.forEach(enqueueTiers);
    cards.forEach((c) => {
      if (c.dataset.faObs || c.dataset.faDone) return;
      c.dataset.faObs = '1';
      io.observe(c);
    });
  }

  function refreshTierObservers() {
    io.disconnect();
    tierQueue.length = 0;
    getCards().forEach((c) => { delete c.dataset.faObs; delete c.dataset.faQ; });
    observeTierCards();
  }

  // ================= Load more pages =================
  // Next page: a "Next" link or GET form on the page, else the page number in the URL (?page=N or /…/N/).
  function findNextUrl(doc, baseUrl) {
    const rel = doc.querySelector('a[rel~="next"][href]');
    if (rel) return new URL(rel.getAttribute('href'), baseUrl).href;
    const a = Array.from(doc.querySelectorAll('a[href]')).find((x) => /^next\b/i.test((x.textContent || '').trim()));
    if (a && !/^(#|javascript:)/.test(a.getAttribute('href'))) return new URL(a.getAttribute('href'), baseUrl).href;
    for (const form of doc.querySelectorAll('form')) {
      if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') continue;
      const btn = Array.from(form.querySelectorAll('button, input[type="submit"]'))
        .find((b) => /^next\b/i.test(((b.textContent || '') + ' ' + (b.value || '')).trim()));
      if (!btn) continue;
      const u = new URL(form.getAttribute('action') || baseUrl, baseUrl);
      form.querySelectorAll('input[name], select[name]').forEach((i) => {
        if (/^(submit|button|checkbox|radio)$/i.test(i.type || '') && !i.checked) return;
        u.searchParams.set(i.name, i.value);
      });
      if (btn.name) u.searchParams.set(btn.name, btn.value);
      return u.href;
    }
    return null;
  }
  function pageNumberUrl(baseUrl, n) {
    const u = new URL(baseUrl);
    if (u.searchParams.has('page') || /^\/browse\/?$/.test(u.pathname)) { u.searchParams.set('page', n); return u.href; }
    const m = u.pathname.match(/^(\/(?:browse|gallery\/[^/]+|scraps\/[^/]+)\/)(\d+)\/?$/);
    if (m) { u.pathname = m[1] + n + '/'; return u.href; }
    if (/^\/(gallery|scraps)\/[^/]+\/?$/.test(u.pathname)) { u.pathname = u.pathname.replace(/\/?$/, '/') + n + '/'; return u.href; }
    return null;
  }
  function pageNumberOf(url) {
    const u = new URL(url);
    const q = parseInt(u.searchParams.get('page'), 10);
    if (q) return q;
    const m = u.pathname.match(/\/(\d+)\/?$/);
    return m && !/^\/(user|journal)\//.test(u.pathname) ? parseInt(m[1], 10) : 1;
  }

  let nextUrl = null;   // where the next "Load more pages" click continues from
  let nextNum = null;
  async function loadMorePages() {
    if (loading) return;
    loading = true;
    cancelled = false;
    let added = 0, pages = 0;
    try {
      if (!nextUrl) {
        nextNum = pageNumberOf(location.href) + 1;
        nextUrl = findNextUrl(document, location.href) || pageNumberUrl(location.href, nextNum);
      }
      const seen = new Set(getCards().map(cardId));
      const want = pagesWanted();
      while (nextUrl && pages < want && !cancelled) {
        showToast('Loading page ' + nextNum + ' (' + (pages + 1) + ' of ' + want + ')… ' + added + ' new so far', true);
        let doc;
        try {
          const res = await fetch(nextUrl, { credentials: 'same-origin' });
          if (!res.ok) { showToast('FA answered ' + res.status + ', stopped loading', false); break; }
          doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        } catch (e) { break; }
        const fresh = getCards(doc).filter((c) => {
          const id = cardId(c);
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        if (!fresh.length) { nextUrl = null; if (!totalPages) totalPages = nextNum - 1; break; }
        const live = getCards();
        let ref = live[live.length - 1];
        if (!ref) break;
        fresh.forEach((c) => {
          const node = document.importNode(c, true);
          ref.parentElement.insertBefore(node, ref.nextSibling);
          ref = node;
        });
        added += fresh.length;
        pages++;
        const base = nextUrl;
        nextNum++;
        nextUrl = findNextUrl(doc, base) || pageNumberUrl(base, nextNum);
        updatePageInfo();
        if (pages < want) await sleep(PAGE_GAP_MS);
      }
    } finally {
      loading = false;
      getCards(); // number the new thumbnails in page order
      showToast((cancelled ? 'Stopped. ' : '') + (added ? 'Added ' + added + ' submissions' : 'No more pages found'), false);
      hideToast(2500);
      updatePageInfo();
      refreshTierObservers();
      if (mode !== 'default') applySort();
    }
  }

  // ================= Toolbar =================
  const BTN_CSS = 'padding:4px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer';
  const bar = document.createElement('div');
  bar.id = 'fa-tiers-bar';
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.12);font:13px system-ui,sans-serif';

  const sortSel = document.createElement('select');
  sortSel.style.cssText = BTN_CSS;
  [['default', 'Sort: FA order'], ['cost_asc', 'True cost: low to high'], ['cost_desc', 'True cost: high to low']].forEach(([v, t]) => sortSel.add(new Option(t, v)));
  sortSel.value = mode;
  sortSel.addEventListener('change', () => setMode(sortSel.value));

  function setMode(m) {
    mode = m;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    sortSel.value = mode;
    if (mode !== 'default' && !tiersOn) setTiers(true); // sorting needs the prices
    applySort();
    refreshTierObservers(); // with a sort on, this queues every thumbnail on the page
  }

  // "Load [N] pages": loads the next N pages, one after another, adding each to this page as it arrives
  const loadBox = document.createElement('span');
  loadBox.style.cssText = 'display:inline-flex;align-items:center;gap:4px';
  const loadBtn = document.createElement('button');
  loadBtn.style.cssText = BTN_CSS;
  loadBtn.textContent = 'Load';
  loadBtn.title = 'Loads the next pages of results one at a time (one every ~1.5 s) and adds them here. Stop button in the corner.';
  const pagesIn = document.createElement('input');
  pagesIn.type = 'number';
  pagesIn.min = '1';
  pagesIn.max = String(PAGES_MAX);
  pagesIn.style.cssText = BTN_CSS + ';width:4.5em;cursor:text';
  try { pagesIn.value = localStorage.getItem(PAGES_KEY) || String(PAGES_DEFAULT); } catch (e) { pagesIn.value = String(PAGES_DEFAULT); }
  pagesIn.addEventListener('change', () => {
    pagesIn.value = String(pagesWanted());
    try { localStorage.setItem(PAGES_KEY, pagesIn.value); } catch (e) {}
  });
  pagesIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pagesIn.blur(); loadMorePages(); } });
  const pagesLbl = document.createElement('span');
  pagesLbl.textContent = 'pages';
  loadBox.append(loadBtn, pagesIn, pagesLbl);
  function pagesWanted() {
    const n = parseInt(pagesIn.value, 10);
    return Math.max(1, Math.min(PAGES_MAX, isNaN(n) ? PAGES_DEFAULT : n));
  }
  loadBtn.addEventListener('click', (e) => { e.preventDefault(); loadMorePages(); });

  // ---- How many pages are there? FA doesn't say, so probe: pages 2, 4, 8, 16... until one is empty,
  //      then halve the gap until the last page is found (about 2 x log2(pages) requests).
  let totalPages = null;   // known total (exact)
  let totalAtLeast = null; // gave up past COUNT_LIMIT
  let counting = false;
  const pageInfo = document.createElement('span');
  pageInfo.style.cssText = 'opacity:.8';
  function updatePageInfo() {
    const first = pageNumberOf(location.href);
    const last = nextNum ? nextNum - 1 : first;
    const showing = first === last ? 'Page ' + first : 'Pages ' + first + '–' + last;
    pageInfo.textContent = showing + (totalPages ? ' of ' + totalPages : totalAtLeast ? ' of ' + totalAtLeast + '+' : '');
  }
  const countBtn = document.createElement('button');
  countBtn.style.cssText = BTN_CSS;
  countBtn.textContent = 'Count pages';
  countBtn.title = 'Finds how many pages of results there are (checks about 10–20 pages)';

  let firstIdOfPage1 = null;
  async function pageExists(n) {
    const url = pageNumberUrl(location.href, n);
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 429 || res.status === 503 || res.status === 403) throw new Error('slow');
    if (!res.ok) return false;
    const cards = getCards(new DOMParser().parseFromString(await res.text(), 'text/html'));
    if (!cards.length) return false;
    return n === 1 || cardId(cards[0]) !== firstIdOfPage1; // FA showing page 1 again = past the end
  }
  async function countPages() {
    if (counting || loading) return;
    if (!pageNumberUrl(location.href, 2)) { pageInfo.textContent = "Can't count pages here"; return; }
    counting = true;
    cancelled = false;
    countBtn.disabled = true;
    try {
      // Search result pages say "(1 - 48 of 1234)": use that if it's there
      const m = (document.body.textContent || '').match(/\(\s*[\d,]+\s*-\s*([\d,]+)\s+of\s+([\d,]+)\s*\)/i);
      const per = getCards().length && m ? parseInt(m[1].replace(/,/g, ''), 10) - 0 : 0;
      if (m && per) {
        const all = parseInt(m[2].replace(/,/g, ''), 10);
        const perPage = parseInt((new URL(location.href).searchParams.get('perpage')) || '', 10) || getCards().length;
        totalPages = Math.max(1, Math.ceil(all / perPage));
        return;
      }
      if (pageNumberOf(location.href) === 1) {
        const c = getCards().find((x) => x.dataset.faOrig === '0') || getCards()[0];
        firstIdOfPage1 = c ? cardId(c) : null;
      } else {
        const res = await fetch(pageNumberUrl(location.href, 1), { credentials: 'same-origin' });
        const c = getCards(new DOMParser().parseFromString(await res.text(), 'text/html'))[0];
        firstIdOfPage1 = c ? cardId(c) : null;
      }
      let lo = Math.max(1, nextNum ? nextNum - 1 : pageNumberOf(location.href)); // a page known to exist
      let hi = lo * 2;
      let checks = 0;
      const step = async (n) => {
        checks++;
        showToast('Counting pages… checking page ' + n + ' (' + checks + ' checked)', true);
        const ok = await pageExists(n);
        await sleep(400);
        return ok;
      };
      while (!cancelled && hi <= COUNT_LIMIT && await step(hi)) { lo = hi; hi *= 2; }
      if (cancelled) return;
      if (hi > COUNT_LIMIT) { totalAtLeast = lo; return; }
      while (!cancelled && hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await step(mid)) lo = mid; else hi = mid;
      }
      if (!cancelled) totalPages = lo;
    } catch (e) {
      showToast(e.message === 'slow' ? 'FA asked to slow down, try counting again later' : 'Counting failed', false);
    } finally {
      counting = false;
      countBtn.disabled = false;
      updatePageInfo();
      if (cancelled) pageInfo.textContent += ' (counting stopped)';
      hideToast(2500);
    }
  }
  countBtn.addEventListener('click', (e) => { e.preventDefault(); countPages(); });
  updatePageInfo();

  const tierBtn = document.createElement('button');
  tierBtn.style.cssText = BTN_CSS;
  const updateTierBtn = () => { tierBtn.textContent = 'Price tiers: ' + (tiersOn ? 'On' : 'Off'); };
  updateTierBtn();
  function setTiers(on) {
    tiersOn = on;
    try { localStorage.setItem(TIERS_ON_KEY, on ? '1' : '0'); } catch (e) {}
    document.querySelectorAll('.fa-tiers').forEach((b) => { b.style.display = on ? '' : 'none'; });
    updateTierBtn();
    if (on) refreshTierObservers();
  }
  tierBtn.addEventListener('click', (e) => { e.preventDefault(); setTiers(!tiersOn); });

  const hideBtn = document.createElement('button');
  hideBtn.style.cssText = BTN_CSS;
  hideBtn.title = 'Hides submissions whose title and description have no price in them';
  const updateHideBtn = () => { hideBtn.textContent = 'Hide no-price: ' + (hideNoPrice ? 'On' : 'Off'); };
  updateHideBtn();
  hideBtn.addEventListener('click', (e) => {
    e.preventDefault();
    hideNoPrice = !hideNoPrice;
    try { localStorage.setItem(HIDE_KEY, hideNoPrice ? '1' : '0'); } catch (err) {}
    updateHideBtn();
    getCards().forEach(applyHide);
  });

  const endedBtn = document.createElement('button');
  endedBtn.style.cssText = BTN_CSS;
  endedBtn.title = 'Hides auctions that are over (the linked auction says it ended, or the title says CLOSED / SOLD / TAKEN)';
  const updateEndedBtn = () => { endedBtn.textContent = 'Hide ended: ' + (hideEnded ? 'On' : 'Off'); };
  updateEndedBtn();
  endedBtn.addEventListener('click', (e) => {
    e.preventDefault();
    hideEnded = !hideEnded;
    try { localStorage.setItem(HIDE_ENDED_KEY, hideEnded ? '1' : '0'); } catch (err) {}
    updateEndedBtn();
    getCards().forEach(applyHide);
  });

  // Ends a "slow down" pause right away and tries again every submission whose read failed
  function retryPrices() {
    tierPausedUntil = 0;
    tierBackoff = 0;
    clearTimeout(pumpTimer);
    pumpTimer = null;
    let failed = 0;
    getCards().forEach((c) => {
      if (!c.dataset.faFailed) return;
      failed++;
      delete c.dataset.faFailed; delete c.dataset.faDone; delete c.dataset.faQ; delete c.dataset.faObs;
    });
    showToast('Retrying prices' + (failed ? ' (' + failed + ' had failed)' : '') + '…', false);
    hideToast(2000);
    refreshTierObservers(); // re-queues what's on screen (or everything, with a sort on)
    pumpTiers();
  }
  const retryBtn = document.createElement('button');
  retryBtn.style.cssText = BTN_CSS;
  retryBtn.textContent = 'Retry prices';
  retryBtn.title = 'Ends a "slow down" pause now and re-reads submissions whose prices failed to load';
  retryBtn.addEventListener('click', (e) => { e.preventDefault(); retryPrices(); });

  const clearBtn = document.createElement('button');
  clearBtn.style.cssText = BTN_CSS;
  cacheCountEl = clearBtn;
  updateCacheCount();
  clearBtn.title = 'Forget saved prices and re-read them from the submissions';
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    clearTimeout(saveTimer);
    tierCache = {};
    clearStore();
    tierQueue.length = 0;
    document.querySelectorAll('.fa-tiers').forEach((b) => b.remove());
    getCards().forEach((c) => {
      delete c.dataset.faDone; delete c.dataset.faQ; delete c.dataset.faObs; delete c._faCost; delete c._faEnded;
      c.style.removeProperty('display');
    });
    showToast('Price cache cleared, re-reading…', false);
    hideToast(2000);
    refreshTierObservers();
  });

  bar.append(sortSel, loadBox, countBtn, pageInfo, tierBtn, hideBtn, endedBtn, retryBtn, clearBtn);

  // The bar goes just above the thumbnails (re-added if FA's own scripts redraw that area)
  function ensureBar() {
    if (bar.isConnected) return;
    const first = getCards()[0];
    if (!first || !first.parentElement) return;
    const gallery = first.parentElement;
    gallery.parentElement ? gallery.insertAdjacentElement('beforebegin', bar) : document.body.prepend(bar);
  }

  // ================= Wiring =================
  const isOurs = (n) => n.nodeType !== 1 || n.classList.contains('fa-tiers') || n === bar || n === toast || n === pop;
  let scanTimer = null;
  const observer = new MutationObserver((recs) => {
    if (applying || loading) return;
    const relevant = recs.some((r) =>
      Array.from(r.addedNodes).some((n) => !isOurs(n)) || Array.from(r.removedNodes).some((n) => !isOurs(n)));
    if (!relevant) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { ensureBar(); observeTierCards(); }, 300);
  });

  if (!getCards().length) {
    // No thumbnails yet (or a page without any): keep watching in case they appear
    observer.observe(document.body, { childList: true, subtree: true });
    return;
  }
  ensureBar();
  observer.observe(document.body, { childList: true, subtree: true });
  observeTierCards();
  if (mode !== 'default') applySort();
})();
