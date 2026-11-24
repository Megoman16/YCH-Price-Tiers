// ==UserScript==
// @name         FurAffinity → Discord Link Copier
// @namespace    https://github.com/Megoman16/YCH-Price-Tiers
// @version      1.1.0
// @description  Right-click any Fur Affinity post and copy a Discord-ready hyperlink ([Title by Artist](url)) with the full image under it.
// @author       Megoman16
// @match        https://www.furaffinity.net/*
// @match        https://furaffinity.net/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Megoman16/YCH-Price-Tiers/main/fa-discord-links.user.js
// @downloadURL  https://raw.githubusercontent.com/Megoman16/YCH-Price-Tiers/main/fa-discord-links.user.js
// ==/UserScript==

(function () {
  'use strict';

  const ORIGIN = 'https://www.furaffinity.net';
  const cache = new Map(); // id -> info

  // ---------- Read a submission page ----------
  function readSubmission(doc, id) {
    const meta = (p) =>
      doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content?.trim() || '';

    const ogTitle = meta('og:title').replace(/\s*--\s*Fur Affinity.*$/i, '');
    let title =
      doc.querySelector('.submission-title h2 p, .submission-title h2, .classic-submission-title h2')
        ?.textContent.trim() || '';
    let artist =
      doc.querySelector('.submission-id-sub-container a strong, .c-usernameBlockSimple__displayName, .classic-submission-title a')
        ?.textContent.trim().replace(/^~/, '') || '';
    if ((!title || !artist) && ogTitle.includes(' by ')) {
      const i = ogTitle.lastIndexOf(' by ');
      title = title || ogTitle.slice(0, i);
      artist = artist || ogTitle.slice(i + 4);
    }
    title = title || `Submission ${id}`;

    let imageUrl = doc.querySelector('.download a, a[href*="d.furaffinity.net"]')?.getAttribute('href') || '';
    if (!imageUrl) {
      const img = doc.querySelector('#submissionImg');
      imageUrl = img?.getAttribute('data-fullview-src') || img?.getAttribute('src') || meta('og:image');
    }
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;

    const ratingText =
      doc.querySelector('.rating-box, .rating .inline, .classic-submission-title + * .rating')?.textContent || '';

    return {
      id,
      title,
      artist,
      imageUrl: /\.(png|jpe?g|gif|webp)(\?|$)/i.test(imageUrl) ? imageUrl : '',
      sensitive: /mature|adult/i.test(ratingText),
    };
  }

  async function getInfo(id) {
    if (cache.has(id)) return cache.get(id);
    const here = location.pathname.match(/^\/(?:view|full)\/(\d+)/);
    let info;
    if (here && here[1] === id) {
      info = readSubmission(document, id);
    } else {
      const res = await fetch(`${ORIGIN}/view/${id}/`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Fur Affinity answered ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      if (doc.querySelector('.redirect-message, #standardpage .notice-message') && !doc.querySelector('#submissionImg'))
        throw new Error('Submission not visible (log in or check your content filter)');
      info = readSubmission(doc, id);
    }
    cache.set(id, info);
    return info;
  }

  // ---------- Build Discord text ----------
  const esc = (s) => s.replace(/([\[\]\\*_~`|])/g, '\\$1');

  function discordText(info, withImage, spoiler) {
    const label = info.artist ? `${esc(info.title)} by ${esc(info.artist)}` : esc(info.title);
    const link = `[${label}](<${ORIGIN}/view/${info.id}/>)`;
    if (!withImage || !info.imageUrl) return link;
    return `${link}\n${spoiler ? `||${info.imageUrl}||` : info.imageUrl}`;
  }

  function copy(text) {
    if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
    else navigator.clipboard.writeText(text);
  }

  // ---------- Toast ----------
  function toast(msg, isError) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      background: isError ? '#c0392b' : '#5865F2', color: '#fff', padding: '8px 14px',
      borderRadius: '6px', font: '600 13px sans-serif', zIndex: 2147483647,
      boxShadow: '0 4px 12px rgba(0,0,0,.4)',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), isError ? 3500 : 1600);
  }

  async function copyFor(id, withImage, spoilerMode) {
    try {
      const info = await getInfo(id);
      const spoiler = spoilerMode === 'auto' ? info.sensitive : spoilerMode === 'on';
      copy(discordText(info, withImage, spoiler));
      toast(withImage && !info.imageUrl ? 'Copied link (no image found)' : 'Copied for Discord!');
    } catch (err) {
      toast(`Couldn't copy: ${err.message}`, true);
    }
  }

  // ---------- Right-click menu ----------
  function findPostId(target) {
    const link = target.closest('a[href*="/view/"], a[href*="/full/"]');
    const m = link?.getAttribute('href')?.match(/\/(?:view|full)\/(\d+)/);
    if (m) return m[1];
    const fig = target.closest('figure[id^="sid-"], [id^="sid-"]');
    if (fig) return fig.id.replace(/\D/g, '');
    // The big picture on a submission page
    if (target.closest('#submissionImg, .submission-area, #columnpage .submission-content img')) {
      const here = location.pathname.match(/^\/(?:view|full)\/(\d+)/);
      if (here) return here[1];
    }
    return null;
  }

  let menu = null;
  function closeMenu() { menu?.remove(); menu = null; }

  function openMenu(x, y, id) {
    closeMenu();
    menu = document.createElement('div');
    Object.assign(menu.style, {
      position: 'fixed', left: `${x}px`, top: `${y}px`, zIndex: 2147483647,
      background: '#2b2d31', border: '1px solid #1e1f22', borderRadius: '6px',
      padding: '4px', minWidth: '220px', boxShadow: '0 8px 20px rgba(0,0,0,.5)',
      font: '13px sans-serif', color: '#dbdee1',
    });

    const items = [
      ['Copy for Discord (link + image)', () => copyFor(id, true, 'auto')],
      ['Copy for Discord (spoiler image)', () => copyFor(id, true, 'on')],
      ['Copy for Discord (link only)', () => copyFor(id, false, 'off')],
    ];
    for (const [label, fn] of items) {
      const it = document.createElement('div');
      it.textContent = label;
      Object.assign(it.style, { padding: '7px 10px', borderRadius: '4px', cursor: 'pointer' });
      it.onmouseenter = () => (it.style.background = '#5865F2');
      it.onmouseleave = () => (it.style.background = '');
      it.onclick = (e) => { e.stopPropagation(); closeMenu(); fn(); };
      menu.appendChild(it);
    }
    const hint = document.createElement('div');
    hint.textContent = 'Shift + right-click for the normal menu';
    Object.assign(hint.style, { padding: '5px 10px 3px', fontSize: '11px', color: '#949ba4' });
    menu.appendChild(hint);

    document.body.appendChild(menu);
    // Keep it on screen
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
    if (r.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;

    // Start loading the post now so the copy is instant
    getInfo(id).catch(() => {});
  }

  document.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) { closeMenu(); return; }
    const id = findPostId(e.target);
    if (!id) { closeMenu(); return; }
    e.preventDefault();
    openMenu(e.clientX, e.clientY, id);
  }, true);

  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  addEventListener('scroll', closeMenu, { passive: true });
  addEventListener('blur', closeMenu);
})();
