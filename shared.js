// Shared by popup.js and bundle.js.

// Runs inside the page (and each iframe); must be self-contained.
function scanPage() {
  const AUDIO = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i;
  const pathOf = u => { try { return new URL(u).pathname; } catch { return u; } };
  const audio = new Set();
  const meta = {};
  for (const e of performance.getEntriesByType('resource')) {
    if (AUDIO.test(pathOf(e.name)) || e.initiatorType === 'audio') {
      audio.add(e.name);
      if (!meta[e.name]) meta[e.name] = { t: Math.round(e.startTime / 100) / 10, kind: e.initiatorType };
    }
  }
  document.querySelectorAll('audio, audio source').forEach(el => {
    const src = el.currentSrc || el.src;
    if (src) {
      audio.add(src);
      if (!meta[src]) meta[src] = { t: null, kind: 'audio element' };
    }
  });
  return { audio: [...audio], meta };
}

// Runs inside the page (and each iframe); must be self-contained.
// Returns null if there's no Table of Contents control in this frame.
async function scrapeToc() {
  const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const rowEls = () => document.querySelectorAll('ul.chapter-dialog-table li.chapter-dialog-row');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let opened = false;
  if (!rowEls().length) {
    const triggers = [
      document.querySelector('button.chapter-bar-title-button'),
      document.querySelector('.chapter-bar-strap'),
    ].filter(Boolean);
    if (!triggers.length) return null;
    for (const t of triggers) {
      t.click();
      opened = true;
      for (let i = 0; i < 15 && !rowEls().length; i++) await sleep(100);
      if (rowEls().length) break;
    }
  }

  const rows = [...rowEls()].map(li => ({
    title: clean(li.querySelector('.chapter-dialog-row-title')?.textContent),
    timestamp: clean(li.querySelector('span.place-phrase-visual')?.textContent),
  }));

  // Best effort: put the page back how we found it by closing the dialog we opened.
  if (opened && rows.length) {
    let node = document.querySelector('ul.chapter-dialog-table')?.parentElement;
    let btn = null;
    for (let depth = 0; node && depth < 5 && !btn; depth++, node = node.parentElement) {
      btn = [...node.querySelectorAll('button')].find(b =>
        /close|dismiss/i.test(b.getAttribute('aria-label') || b.title || b.textContent));
    }
    if (btn) btn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  return { rows };
}

// Runs inside the page (and each iframe); must be self-contained.
// The player only requests an audio part once playback reaches it, so step through every chapter
// to make it request all of them. Ends back on the first chapter. Returns null if no TOC here.
async function sweepChapters(delayMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Background tabs get throttled and the player won't load audio while hidden, so wait until
  // this tab is in front (visibilitychange isn't throttled like timers are).
  const whenVisible = () => document.visibilityState === 'visible'
    ? Promise.resolve()
    : new Promise(resolve => {
        const onChange = () => {
          if (document.visibilityState !== 'visible') return;
          document.removeEventListener('visibilitychange', onChange);
          resolve();
        };
        document.addEventListener('visibilitychange', onChange);
      });
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;' +
    'background:#2d6cdf;color:#fff;font:600 14px system-ui,sans-serif;text-align:center;pointer-events:none';
  const say = text => { banner.textContent = text; };

  // Some parts are only requested while the player is actually playing, so keep it playing (muted)
  // during the sweep and put play/pause and volume back afterwards.
  const audios = () => [...document.querySelectorAll('audio')];
  const findToggle = () => {
    const btn = document.querySelector('button.playback-toggle');
    if (btn) return btn;
    const hit = document.querySelector('[class*="playback-toggle"]');
    return hit ? (hit.closest('button, [role="button"], a') || hit) : null;
  };
  const clickEl = el => {
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  };
  // The button's aria-label says what a click will do ("Play" → it is paused, "Pause" → it is playing),
  // so it is the most reliable signal; fall back to the <audio> element if the label is something else.
  const playState = () => {
    const t = findToggle();
    const label = t ? `${t.getAttribute('aria-label') || ''} ${t.title || ''}` : '';
    if (/pause|\bplaying\b/i.test(label)) return 'playing';
    if (/\b(play|resume|replay)\b/i.test(label)) return 'paused';
    const as = audios();
    if (as.length) return as.some(a => !a.paused && !a.ended) ? 'playing' : 'paused';
    return 'unknown';
  };
  let toggledOnce = false;
  let lastClick = 0;
  const ensurePlaying = async () => {
    const state = playState();
    // Don't re-click while a previous click is still taking effect (the player shows a loading
    // state first), or a second click would pause it again.
    if (state === 'playing' || Date.now() - lastClick < Math.min(2000, delayMs / 2)) return;
    if (state === 'unknown' && toggledOnce) return;
    const t = findToggle();
    if (!t) return;
    clickEl(t);
    toggledOnce = true;
    lastClick = Date.now();
    for (let i = 0; i < 20 && playState() !== 'playing'; i++) await sleep(100);
  };
  const mutedBefore = new Map();
  const muteAll = () => audios().forEach(a => {
    if (!mutedBefore.has(a)) mutedBefore.set(a, a.muted);
    a.muted = true;
  });

  const rowEls = () => document.querySelectorAll('ul.chapter-dialog-table li.chapter-dialog-row');
  const openDialog = async () => {
    if (rowEls().length) return true;
    const triggers = [
      document.querySelector('button.chapter-bar-title-button'),
      document.querySelector('.chapter-bar-strap'),
    ].filter(Boolean);
    for (const t of triggers) {
      t.click();
      for (let i = 0; i < 15 && !rowEls().length; i++) await sleep(100);
      if (rowEls().length) return true;
    }
    return false;
  };
  const press = async i => {
    await whenVisible();
    if (!(await openDialog())) return;
    const li = rowEls()[i];
    if (li) (li.querySelector('button, a, [role="button"]') || li).click();
  };

  say('OdioFile: waiting for this tab to be in front…');
  document.documentElement.append(banner);
  await whenVisible();
  if (!(await openDialog())) { banner.remove(); return null; }
  const initialState = playState();
  const toggle = findToggle();
  const muter = setInterval(muteAll, 100);
  muteAll();
  await ensurePlaying();

  const total = rowEls().length;
  for (let i = 0; i < total; i++) {
    say(`OdioFile: loading audio — chapter ${i + 1} of ${total}. Keep this tab in front.`);
    await press(i);
    await sleep(delayMs);
    await ensurePlaying();
  }
  say('OdioFile: returning to the start…');
  await press(0);
  await sleep(delayMs);
  clearInterval(muter);

  if (rowEls().length) {
    let node = document.querySelector('ul.chapter-dialog-table')?.parentElement;
    let btn = null;
    for (let depth = 0; node && depth < 5 && !btn; depth++, node = node.parentElement) {
      btn = [...node.querySelectorAll('button')].find(b =>
        /close|dismiss/i.test(b.getAttribute('aria-label') || b.title || b.textContent));
    }
    if (btn) btn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
  // Restore: pause again if we were the ones who started playback, then undo the muting.
  if (initialState !== 'playing' && playState() === 'playing') {
    const t = findToggle();
    if (t) clickEl(t);
    await sleep(300);
    if (playState() === 'playing') audios().forEach(a => a.pause());
  }
  for (const [a, wasMuted] of mutedBefore) a.muted = wasMuted;

  say('OdioFile: done — switch back to the OdioFile build tab.');
  setTimeout(() => banner.remove(), 20000);
  const playback = initialState === 'playing' ? 'player was already playing'
    : toggle ? 'started playback with the play button'
    : 'play button not found — ran without playback';
  return { clicked: total, playback };
}

// Runs inside the page (and each iframe); must be self-contained.
// The cover is an SVG shell whose <use> points at an element (#cover-painter-image) that holds
// the real image, so there is no .svg file on the network to grab — read the URL from the DOM.
function findCover() {
  const XLINK = 'http://www.w3.org/1999/xlink';
  const hrefOf = el => el.getAttribute('href') || el.getAttributeNS(XLINK, 'href') || el.getAttribute('xlink:href') || '';
  const imgUrl = el => {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') return el.currentSrc || el.src;
    if (tag === 'image') return hrefOf(el);
    const inner = el.querySelector('image, img');
    if (inner) return imgUrl(inner);
    const bg = ((el.style && el.style.backgroundImage) || '').match(/url\(["']?(.*?)["']?\)/);
    return bg ? bg[1] : '';
  };

  const target = document.getElementById('cover-painter-image');
  let url = imgUrl(target);
  if (!url) {
    for (const u of document.querySelectorAll('svg.cover-image-icon use')) {
      url = imgUrl(document.getElementById(hrefOf(u).replace(/^#/, '')));
      if (url) break;
    }
  }
  if (!url) url = imgUrl(document.querySelector('img[class*="cover" i]'));
  if (!url) url = document.querySelector('meta[property="og:image"]')?.content || '';

  if (url && !url.startsWith('data:')) {
    try { url = new URL(url, location.href).href; } catch { url = ''; }
  }
  const diag = target
    ? `#cover-painter-image is <${target.tagName.toLowerCase()}>: ${target.outerHTML.slice(0, 200)}`
    : 'no #cover-painter-image element in this frame';
  return { url, diag };
}

const EXT = {
  audio: /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i,
};
// Content-types we accept per kind (servers often mislabel media as octet-stream)
const ACCEPT = {
  audio: /^(audio\/|application\/ogg|video\/ogg|video\/mp4|application\/octet-stream|binary\/octet-stream)/i,
};
const EXT_FOR_TYPE = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/ogg': '.ogg', 'application/ogg': '.ogg', 'video/ogg': '.ogg',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a',
  'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'audio/opus': '.opus', 'audio/webm': '.weba',
};

const pathOf = u => { try { return new URL(u).pathname; } catch { return u; } };

function nameFor(url) {
  let name = '';
  try { name = decodeURIComponent(pathOf(url).split('/').pop()); } catch {}
  return (name || 'file').replace(/[\\/:*?"<>|]/g, '_');
}

// Adds an extension from the content-type when the URL path has none (e.g. hash-named files).
function finalName(url, kind, type) {
  const name = nameFor(url);
  if (EXT[kind].test(name)) return name;
  return name + (EXT_FOR_TYPE[type] || '');
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Returns { type, length } from response headers, or null if the server can't be asked.
async function probe(url) {
  const attempts = [{ method: 'HEAD' }, { headers: { Range: 'bytes=0-0' } }];
  for (const opts of attempts) {
    const ctrl = new AbortController();
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, credentials: 'include' });
      ctrl.abort();
      if (!res.ok) continue;
      const range = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
      const length = range ? Number(range[1]) : Number(res.headers.get('content-length')) || 0;
      return { type: (res.headers.get('content-type') || '').split(';')[0].trim(), length };
    } catch {}
  }
  return null;
}

// Probes each URL, drops wrong content-types, and (audio only) drops extensionless copies
// of files the page already loaded under a real name. Returns { keep, skipped, dupes }.
async function selectFiles(kind, urls) {
  const skipped = [];
  const keep = [];
  const report = []; // every candidate, with what happened to it

  for (let i = 0; i < urls.length; i += 8) {
    await Promise.all(urls.slice(i, i + 8).map(async url => {
      const info = await probe(url);
      const type = info ? info.type : '';
      const length = info ? info.length : 0;
      const ok = info === null ? EXT[kind].test(pathOf(url)) : ACCEPT[kind].test(type);
      const entry = { url, type, length, status: ok ? 'kept' : 'dropped', reason: ok ? '' : `not ${kind} (${type || 'unreachable'})` };
      report.push(entry);
      if (!ok) { skipped.push(`${url} (${type || 'unreachable'})`); return; }
      keep.push(entry);
    }));
  }

  let dupes = 0;
  let result = keep;
  if (kind === 'audio') {
    const namedSizes = new Set(
      keep.filter(r => r.length && EXT.audio.test(pathOf(r.url))).map(r => r.length)
    );
    result = keep.filter(r => {
      const dupe = r.length && !EXT.audio.test(pathOf(r.url)) && namedSizes.has(r.length);
      if (dupe) {
        dupes++;
        r.status = 'dropped';
        r.reason = 'extensionless; same size as a named file';
        skipped.push(`${nameFor(r.url)} (duplicate of a named file, ${r.length} bytes)`);
      }
      return !dupe;
    });
  }
  return { keep: result, skipped, dupes, report };
}

// Scrapes the chapter list from the page. Returns { rows } or { error }.
async function getToc(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: scrapeToc,
  });
  const hits = results.map(r => r.result).filter(Boolean);
  if (!hits.length) return { error: "Couldn't find the Table of Contents button on this page." };
  const rows = hits.find(h => h.rows.length)?.rows;
  if (!rows) return { error: 'Clicked Table of Contents, but no chapter rows appeared.' };
  return { rows };
}

// Returns { url, diag }; url is '' when no cover was found.
async function getCover(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: findCover,
  });
  const vals = results.map(r => r.result).filter(Boolean);
  return vals.find(v => v.url) || vals.find(v => !v.diag.startsWith('no #')) || vals[0] || { url: '', diag: 'page not readable' };
}

function timestampSeconds(text) {
  const parts = String(text).trim().split(':').map(Number);
  if (!parts.length || parts.length > 3 || parts.some(n => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// The book title is the chapter that starts at 0:00 (falls back to the first row).
function bookTitle(rows) {
  const row = rows.find(r => timestampSeconds(r.timestamp) === 0) || rows[0];
  return row ? row.title : '';
}

// Part files follow one naming pattern within a book (…Part01.mp3, …Part02.mp3). Given the ones
// found, probe the numbers in between and the next numbers after the highest, reusing a found URL
// as the template. Returns { added, missing } where missing are gap numbers that couldn't be found.
async function fillMissingParts(keep, probeFn = probe) {
  const re = /(part)(\d+)/i;
  const numbered = keep.filter(r => re.test(pathOf(r.url)));
  if (!numbered.length) return { added: [], missing: [] };

  const width = pathOf(numbered[0].url).match(re)[2].length;
  const have = new Set(numbered.map(r => Number(pathOf(r.url).match(re)[2])));
  const max = Math.max(...have);
  const make = n => {
    const u = new URL(numbered[0].url);
    u.pathname = u.pathname.replace(re, (_, p) => p + String(n).padStart(width, '0'));
    return u.href;
  };
  const tryPart = async n => {
    const url = make(n);
    const info = await probeFn(url);
    if (info && ACCEPT.audio.test(info.type)) return { url, type: info.type, length: info.length };
    return { fail: info ? `server answered with ${info.type || 'an unknown type'}, not audio` : 'request failed or was refused' };
  };

  const added = [];
  const missing = [];
  const why = {};
  for (let n = 1; n < max; n++) {
    if (have.has(n)) continue;
    const found = await tryPart(n);
    if (found.fail) { missing.push(n); why[n] = found.fail; } else added.push(found);
  }
  for (let n = max + 1; n <= max + 300; n++) {
    const found = await tryPart(n);
    if (found.fail) break;
    added.push(found);
  }
  return { added, missing, why };
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const p = n => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function tocToCsv(rows) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  return ['Title,Timestamp', ...rows.map(r => `${q(r.title)},${q(r.timestamp)}`)].join('\r\n');
}

// UTF-8 BOM so Excel reads accented characters correctly.
const csvDataUrl = csv => 'data:text/csv;charset=utf-8,' + encodeURIComponent('﻿' + csv);

// ---- MP3 joining ----

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1 layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],      // MPEG2/2.5 layer III
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Finds the byte range of a part that should be kept when joining MP3s: drops the leading
// ID3v2 tag(s), a leading Xing/Info/VBRI header frame (it describes this part only, so it
// would give the joined file the wrong length), and a trailing ID3v1 tag.
// Returns null if no MP3 frame is found.
async function mp3Bounds(blob) {
  const read = async (s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());

  let start = 0;
  for (;;) {
    const h = await read(start, start + 10);
    if (h.length === 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) {
      start += 10 + ((h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9]) + (h[5] & 0x10 ? 10 : 0);
    } else break;
  }

  const w = await read(start, start + 8192);
  let f = 0;
  while (f + 4 <= w.length && !(w[f] === 0xff && (w[f + 1] & 0xe0) === 0xe0)) f++;
  if (f + 4 > w.length) return null;
  start += f;

  const ver = (w[f + 1] >> 3) & 3;
  const layer = (w[f + 1] >> 1) & 3;
  const hasCrc = !(w[f + 1] & 1);
  const brIdx = w[f + 2] >> 4;
  const srIdx = (w[f + 2] >> 2) & 3;
  const pad = (w[f + 2] >> 1) & 1;
  const mono = (w[f + 3] >> 6) === 3;
  let bitrate = 0;
  if (layer === 1 && ver !== 1 && brIdx > 0 && brIdx < 15 && srIdx < 3) {
    const mpeg1 = ver === 3;
    bitrate = MP3_BITRATES[mpeg1 ? 1 : 2][brIdx] * 1000;
    const frameLen = Math.floor((mpeg1 ? 144 : 72) * bitrate / MP3_RATES[ver][srIdx]) + pad;
    const side = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const at = f + 4 + (hasCrc ? 2 : 0) + side;
    const text = (i) => String.fromCharCode(...w.slice(i, i + 4));
    if (['Xing', 'Info'].includes(text(at)) || text(f + 36) === 'VBRI') start += frameLen;
  }

  let end = blob.size;
  if (end - start > 128) {
    const t = await read(end - 128, end);
    if (t[0] === 0x54 && t[1] === 0x41 && t[2] === 0x47) end -= 128;
  }
  return { start, end, bitrate };
}

// ---- Splitting a merged MP3 into chapter files ----

// Parses a Layer III frame header at w[i]; returns { len, ver, srIdx } or null.
function mp3FrameAt(w, i) {
  if (i + 4 > w.length || w[i] !== 0xff || (w[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (w[i + 1] >> 3) & 3;
  const layer = (w[i + 1] >> 1) & 3;
  const brIdx = w[i + 2] >> 4;
  const srIdx = (w[i + 2] >> 2) & 3;
  const pad = (w[i + 2] >> 1) & 1;
  if (layer !== 1 || ver === 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const mpeg1 = ver === 3;
  const bitrate = MP3_BITRATES[mpeg1 ? 1 : 2][brIdx] * 1000;
  return { len: Math.floor((mpeg1 ? 144 : 72) * bitrate / MP3_RATES[ver][srIdx]) + pad, ver, srIdx };
}

// First real frame start at or after `estimate`. A candidate only counts if the next two frames
// also parse with matching settings, so stray 0xFF bytes inside audio data don't fool it.
async function findFrameStart(blob, estimate) {
  const from = Math.max(0, Math.round(estimate));
  const w = new Uint8Array(await blob.slice(from, from + 6000).arrayBuffer());
  for (let i = 0; i + 4 <= w.length; i++) {
    const a = mp3FrameAt(w, i);
    if (!a) continue;
    const b = mp3FrameAt(w, i + a.len);
    if (!b || b.ver !== a.ver || b.srIdx !== a.srIdx) continue;
    const c = mp3FrameAt(w, i + a.len + b.len);
    if (!c || c.ver !== a.ver || c.srIdx !== a.srIdx) continue;
    return from + i;
  }
  return null;
}

// ID3v2.3 tag with title, album, track "n/N", genre "Audiobook" and (if given) front-cover art.
// `cover` is { bytes: Uint8Array, mime: 'image/jpeg' | 'image/png' } or null.
function id3Tag({ title, album, track, total, cover }) {
  const ascii = s => Uint8Array.from(s, ch => ch.charCodeAt(0) & 0x7f);
  const utf16 = s => {
    const out = new Uint8Array(3 + s.length * 2);
    out[0] = 1; out[1] = 0xff; out[2] = 0xfe; // encoding 1 = UTF-16 with BOM (little endian)
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[3 + i * 2] = c & 0xff;
      out[4 + i * 2] = c >> 8;
    }
    return out;
  };
  const frame = (id, body) => {
    const out = new Uint8Array(10 + body.length);
    out.set(ascii(id), 0);
    new DataView(out.buffer).setUint32(4, body.length);
    out.set(body, 10);
    return out;
  };
  const frames = [
    frame('TIT2', utf16(title)),
    frame('TALB', utf16(album)),
    frame('TRCK', utf16(`${track}/${total}`)),
    frame('TCON', utf16('Audiobook')),
  ];
  if (cover) {
    const mime = ascii(cover.mime);
    const body = new Uint8Array(1 + mime.length + 1 + 1 + 1 + cover.bytes.length);
    body.set(mime, 1);                           // encoding byte 0 (Latin-1), then MIME type
    body[1 + mime.length + 1] = 3;               // picture type 3 = front cover (description left empty)
    body.set(cover.bytes, 1 + mime.length + 3);
    frames.push(frame('APIC', body));
  }
  const size = frames.reduce((n, f) => n + f.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set(ascii('ID3'), 0);
  tag[3] = 3; // v2.3.0
  tag[6] = (size >> 21) & 0x7f; tag[7] = (size >> 14) & 0x7f; tag[8] = (size >> 7) & 0x7f; tag[9] = size & 0x7f;
  let at = 10;
  for (const f of frames) { tag.set(f, at); at += f.length; }
  return tag;
}

// Cuts a merged, constant-bitrate MP3 into one tagged blob per chapter without re-encoding.
// `chapters` are { title, start } (start in seconds, ascending, the first at 0).
// Returns { files: [{ title, blob, start }], skipped: [{ title, reason }] }.
async function splitMp3(merged, bitrate, chapters, { album, cover }) {
  const bytesPerSecond = bitrate / 8;
  const cuts = [];
  const skipped = [];
  for (const ch of chapters) {
    const at = cuts.length ? await findFrameStart(merged, ch.start * bytesPerSecond) : 0;
    if (at === null || at >= merged.size) { skipped.push({ title: ch.title, reason: 'starts after the end of the audio' }); continue; }
    if (cuts.length && at <= cuts[cuts.length - 1].at) { skipped.push({ title: ch.title, reason: 'starts at the same moment as the chapter before it' }); continue; }
    cuts.push({ title: ch.title, start: ch.start, at });
  }
  const files = cuts.map((c, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].at : merged.size;
    const tag = id3Tag({ title: c.title, album, track: i + 1, total: cuts.length, cover });
    return { title: c.title, start: c.start, blob: new Blob([tag, merged.slice(c.at, end)], { type: 'audio/mpeg' }) };
  });
  return { files, skipped };
}
