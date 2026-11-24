// ==UserScript==
// @name         FurAffinity → Discord Link Copier
// @namespace    https://github.com/Megoman16/YCH-Price-Tiers
// @version      1.2.0
// @description  Right-click a Fur Affinity post's picture to copy a Discord-ready hyperlink ([Title by Artist](url)) with the full-size image, or the full-size image itself.
// @author       Megoman16
// @match        https://www.furaffinity.net/*
// @match        https://furaffinity.net/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      d.furaffinity.net
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

    // Full-size file, best source first: the Download button, then the full view
    // of the main picture. Never the gallery thumbnail (t.furaffinity.net).
    const img = doc.querySelector('#submissionImg');
    const candidates = [
      doc.querySelector('.download a, .download-logged-in a, #page-submission .actions a[href*="d.furaffinity.net/art/"]')?.getAttribute('href'),
      doc.querySelector('a[href*="d.furaffinity.net/art/"]')?.getAttribute('href'),
      img?.getAttribute('data-fullview-src'),
      img?.getAttribute('src'),
    ];
    let imageUrl = candidates.find((u) => u && /d\.furaffinity\.net\/art\//.test(u)) || '';
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

  // ---------- Copy the image itself ----------
  function fetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error(`image answered ${r.status}`))),
        onerror: () => reject(new Error('image download failed')),
      });
    });
  }

  // Browsers only accept PNG on the clipboard, so redraw the image as PNG.
  async function toPng(blob) {
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('convert failed'))), 'image/png'));
  }

  async function pngFor(id) {
    const info = await getInfo(id);
    if (!info.imageUrl) throw new Error('no full-size image on this post');
    return toPng(await fetchBlob(info.imageUrl));
  }

  function copyImage(id) {
    // ClipboardItem must be created right inside the click, with the image
    // passed as a promise, or the browser refuses because the click "expired".
    const png = pngFor(id);
    let write;
    try {
      write = navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    } catch (e) {
      write = Promise.reject(e);
    }
    write
      .then(() => toast('Copied full-size image!'))
      .catch(async (err) => {
        // Fallback: copy the full-size image address instead.
        try {
          const info = await getInfo(id);
          if (!info.imageUrl) throw err;
          copy(info.imageUrl);
          toast("Your browser wouldn't copy the picture, so the full-size image link was copied instead", true);
        } catch (e2) {
          toast(`Couldn't copy image: ${e2.message || err.message}`, true);
        }
      });
  }

  // ---------- Right-click menu ----------
  // Only right-clicks on a post's picture get the custom menu.
  function findPostId(target) {
    const img = target.closest('img');
    if (!img) return null;

    // The main picture on a submission page
    if (img.id === 'submissionImg') {
      const here = location.pathname.match(/^\/(?:view|full)\/(\d+)/);
      return here ? here[1] : null;
    }

    // A thumbnail that links to a post
    const link = img.closest('a[href*="/view/"], a[href*="/full/"]');
    const m = link?.getAttribute('href')?.match(/\/(?:view|full)\/(\d+)/);
    if (m) return m[1];

    const fig = img.closest('figure[id^="sid-"]');
    if (fig) return fig.id.replace(/\D/g, '');
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
      ['Copy image (full size)', () => copyImage(id)],
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
