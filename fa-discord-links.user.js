// ==UserScript==
// @name         FurAffinity → Discord Link Copier
// @namespace    https://github.com/YOUR-USERNAME/fa-discord-links
// @version      1.0.0
// @description  Adds buttons on FurAffinity submissions that copy a Discord-ready hyperlink ([Title by Artist](url)), optionally with the direct image so it embeds.
// @author       YOUR-USERNAME
// @match        https://www.furaffinity.net/view/*
// @match        https://www.furaffinity.net/full/*
// @match        https://furaffinity.net/view/*
// @match        https://furaffinity.net/full/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/YOUR-USERNAME/fa-discord-links/main/fa-discord-links.user.js
// @downloadURL  https://raw.githubusercontent.com/YOUR-USERNAME/fa-discord-links/main/fa-discord-links.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Gather submission info ----------
  const meta = (prop) =>
    document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.content?.trim() || '';

  const idMatch = location.pathname.match(/\/(?:view|full)\/(\d+)/);
  if (!idMatch) return;
  const id = idMatch[1];
  const pageUrl = `https://www.furaffinity.net/view/${id}/`;

  // og:title looks like "Title by Artist -- Fur Affinity [dot] net"
  const ogTitle = meta('og:title').replace(/\s*--\s*Fur Affinity.*$/i, '');

  let title =
    document.querySelector('.submission-title h2 p, .submission-title h2, .classic-submission-title h2')
      ?.textContent.trim() || '';
  let artist =
    document.querySelector('.submission-id-sub-container a strong, .c-usernameBlockSimple__displayName, .classic-submission-title a')
      ?.textContent.trim().replace(/^~/, '') || '';

  if ((!title || !artist) && ogTitle.includes(' by ')) {
    const i = ogTitle.lastIndexOf(' by ');
    title = title || ogTitle.slice(0, i);
    artist = artist || ogTitle.slice(i + 4);
  }
  title = title || `Submission ${id}`;

  // Direct image (d.furaffinity.net) — Discord embeds these as images.
  const dl = document.querySelector('.download a, a[href*="d.furaffinity.net"]');
  let imageUrl = dl?.getAttribute('href') || '';
  if (!imageUrl) {
    const img = document.querySelector('#submissionImg');
    imageUrl = img?.getAttribute('data-fullview-src') || img?.getAttribute('src') || meta('og:image');
  }
  if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
  const isImage = /\.(png|jpe?g|gif|webp)(\?|$)/i.test(imageUrl);

  // Rating (General / Mature / Adult) — used to auto-spoiler non-General images.
  const ratingText =
    document.querySelector('.rating-box, .rating .inline, .classic-submission-title + * .rating')?.textContent || '';
  const isSensitive = /mature|adult/i.test(ratingText);

  // ---------- Build Discord text ----------
  // Escape characters that would break a Discord masked link.
  const esc = (s) => s.replace(/([\[\]\\*_~`|])/g, '\\$1');
  const label = artist ? `${esc(title)} by ${esc(artist)}` : esc(title);

  // <url> inside the masked link stops Discord from making FA's (weak) preview embed.
  const linkOnly = `[${label}](<${pageUrl}>)`;

  function linkWithImage(spoiler) {
    if (!isImage) return linkOnly;
    const img = spoiler ? `||${imageUrl}||` : imageUrl;
    return `${linkOnly}\n${img}`;
  }

  // ---------- UI ----------
  function copy(text, btn) {
    if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
    else navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = old), 1200);
  }

  function makeBtn(text, tip, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = tip;
    Object.assign(b.style, {
      background: '#5865F2', color: '#fff', border: 'none', borderRadius: '4px',
      padding: '6px 10px', margin: '4px 6px 4px 0', cursor: 'pointer',
      font: '600 13px sans-serif',
    });
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(e, b); });
    return b;
  }

  const bar = document.createElement('div');
  bar.id = 'fa-discord-bar';
  bar.style.margin = '8px 0';

  bar.append(
    makeBtn('Discord: link', 'Copies [Title by Artist](link) with no embed', (e, b) => copy(linkOnly, b)),
    makeBtn(
      'Discord: link + image',
      'Copies the hyperlink plus the direct image so Discord embeds it.\nMature/Adult images are spoilered automatically. Shift-click to toggle spoiler.',
      (e, b) => copy(linkWithImage(isSensitive !== e.shiftKey), b)
    )
  );

  const anchor =
    document.querySelector('.submission-title, .classic-submission-title, #submissionImg') || document.body.firstElementChild;
  anchor.parentNode.insertBefore(bar, anchor.nextSibling);
})();
