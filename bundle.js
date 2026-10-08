const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const bookName = (params.get('title') || '').trim();
const doSweep = params.get('sweep') !== '0';
const doSplit = params.get('split') === '1';
const SWEEP_DELAY_MS = 2500; // pause after each chapter click so the player has time to request its audio
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Files are collected here and only written to disk once the whole build has succeeded.
const pending = [];

function log(text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  $('log').append(li);
  return li;
}

async function saveAndWait(options) {
  const id = await chrome.downloads.download({ ...options, conflictAction: 'uniquify' });
  await new Promise((resolve, reject) => {
    const onChanged = d => { if (d.id === id) check(); };
    const finish = fn => { chrome.downloads.onChanged.removeListener(onChanged); fn(); };
    async function check() {
      const [item] = await chrome.downloads.search({ id });
      if (item.state === 'complete') finish(resolve);
      else if (item.state === 'interrupted') finish(() => reject(new Error(item.error || 'download interrupted')));
    }
    chrome.downloads.onChanged.addListener(onChanged);
    check();
  });
  const [item] = await chrome.downloads.search({ id });
  return item.filename;
}

async function fetchBlob(url, onProgress) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  return new Blob(chunks);
}

function safeFolder(title) {
  return title
    .replace(/:\s*/g, ' - ')
    .replace(/[\\/*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'audiobook';
}

// If an earlier build already made this folder, add a timestamp rather than mixing the two builds.
async function uniqueFolder(base) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const earlier = await chrome.downloads.search({ filenameRegex: `[/\\\\]OdioFile[/\\\\]${escaped}[/\\\\]` });
  return earlier.some(d => d.exists) ? `${base} (${timestamp()})` : base;
}

async function readChapters() {
  const line = log('Reading Table of Contents…');
  try {
    const toc = await getToc(tabId);
    if (toc.error) {
      line.textContent = toc.error + ' Continuing without chapters.';
      line.className = 'warn';
      return null;
    }
    pending.push({
      name: 'table-of-contents.csv',
      blob: new Blob(['﻿' + tocToCsv(toc.rows)], { type: 'text/csv;charset=utf-8' }),
    });
    line.textContent = `Read ${toc.rows.length} chapters`;
    line.className = 'ok';
    return toc.rows;
  } catch (err) {
    line.textContent = `Couldn't read chapters (${err.message}) — continuing.`;
    line.className = 'warn';
    return null;
  }
}

const COVER_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

async function readCover() {
  const line = log('Looking for the cover image…');
  try {
    const cover = await getCover(tabId);
    if (!cover.url) {
      line.textContent = `No cover found (${cover.diag}). Continuing without one.`;
      line.className = 'warn';
      return;
    }
    const res = await fetch(cover.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const ext = COVER_EXT[blob.type] ||
      (cover.url.match(/\.(jpe?g|png|webp|gif)(\?|$)/i)?.[1].toLowerCase().replace('jpeg', 'jpg')) || 'jpg';
    pending.push({ name: `cover.${ext}`, blob });
    line.textContent = `Got the cover (${ext}, ${Math.round(blob.size / 1024)} KB)`;
    line.className = 'ok';
  } catch (err) {
    line.textContent = `Couldn't get the cover (${err.message}). Continuing.`;
    line.className = 'warn';
  }
}

// The player only requests a part when playback reaches it, and only while its tab is in front,
// so the user has to switch to the player tab while it steps through the chapters.
async function sweepParts() {
  const pageTitle = document.title;
  $('callout-title').textContent = 'Action needed: switch to the player tab';
  $('callout-body').textContent =
    'The chapter sweep runs in the player tab, and the page only loads audio while that tab is in front. ' +
    'It will start playback (muted) and step through the chapters, then put playback and volume back. ' +
    'Go there now and leave it alone until the blue banner says it is done, then come back to this tab.';
  $('go-player').hidden = false;
  $('callout').hidden = false;
  document.title = '→ Go to the player tab';
  const line = log('Waiting for the player tab to be in front, then stepping through every chapter…');
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: sweepChapters,
      args: [SWEEP_DELAY_MS],
    });
    const hit = results.map(r => r.result).find(Boolean);
    if (!hit) {
      line.textContent = "Couldn't find the Table of Contents to step through — using only what's already loaded.";
      line.className = 'warn';
      return;
    }
    await sleep(5000); // let the last requests finish
    line.textContent = `Stepped through ${hit.clicked} chapters (${hit.playback}); the player is back at the start. You can return to this tab.`;
    line.className = hit.playback.startsWith('play button not found') ? 'warn' : 'ok';
  } catch (err) {
    line.textContent = `Chapter sweep failed (${err.message}) — using only what's already loaded.`;
    line.className = 'warn';
  } finally {
    $('callout').hidden = true;
    document.title = pageTitle;
  }
}

// Scans the page for audio parts, drops duplicates/non-audio, and tries to fill numbering gaps.
async function collectParts() {
  const scanning = log('Finding audio files…');
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: scanPage,
  });
  const urls = [...new Set(results.flatMap(r => (r.result ? r.result.audio : [])))].filter(u => /^https?:/i.test(u));
  const meta = Object.assign({}, ...results.map(r => (r.result ? r.result.meta : {})));
  const selected = await selectFiles('audio', urls);
  if (!selected.keep.length) throw new Error('No audio files found on the page.');

  const guess = log('Checking for parts the page never loaded…');
  const fill = await fillMissingParts(selected.keep);
  selected.keep.push(...fill.added);
  selected.report.push(...fill.added.map(a => ({ ...a, status: 'kept', reason: 'guessed from the part numbering' })));
  guess.textContent = fill.added.length
    ? `Added ${fill.added.length} part(s) the page hadn't loaded, found from the naming pattern.`
    : 'No extra parts found beyond what the page loaded.';
  guess.className = fill.added.length ? 'ok' : 'warn';
  return { ...selected, missing: fill.missing, why: fill.why, scanning, meta };
}

// Host, path pattern and query key names (never values) — shows whether URLs carry per-file tokens.
function urlShape(report) {
  const named = report.filter(r => r.status === 'kept' && /part\d+/i.test(pathOf(r.url)));
  if (!named.length) return '';
  const u = new URL(named[0].url);
  const keys = [...u.searchParams.keys()].join(', ') || 'none';
  const queries = new Set(named.map(r => new URL(r.url).search));
  const pattern = u.pathname.replace(/(part)\d+/i, '$1NN');
  return `URL shape: ${u.host}${pattern} — query keys: ${keys}; same query on every named part: ` +
    (queries.size === 1 ? 'yes' : `no (${queries.size} different)`);
}

// One row per audio candidate, in the order the page requested them, with what we did with it.
function showReport({ report, meta, missing }) {
  const sizeCount = {};
  for (const r of report) if (r.length) sizeCount[r.length] = (sizeCount[r.length] || 0) + 1;
  const rows = report
    .map(r => ({
      name: nameFor(r.url),
      bytes: r.length,
      t: meta[r.url] ? meta[r.url].t : null,
      via: meta[r.url] ? meta[r.url].kind : 'guessed',
      same: r.length && sizeCount[r.length] > 1 ? `×${sizeCount[r.length]}` : '',
      status: r.status,
      reason: r.reason,
    }))
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));

  const kept = rows.filter(r => r.status === 'kept').length;
  const li = document.createElement('li');
  const det = document.createElement('details');
  det.open = true;
  const sum = document.createElement('summary');
  sum.textContent = `Audio report: ${rows.length} candidates — ${kept} kept, ${rows.length - kept} dropped` +
    (missing.length ? ` — numbering gaps: Part ${missing.join(', ')}` : '');
  det.append(sum);

  const nums = [...new Set(report.filter(r => r.status === 'kept')
    .map(r => pathOf(r.url).match(/part(\d+)/i)).filter(Boolean).map(m => Number(m[1])))].sort((a, b) => a - b);
  const info = [`Parts present: ${nums.join(', ') || 'none numbered'}`, urlShape(report)].filter(Boolean);
  for (const text of info) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = text;
    det.append(d);
  }

  const head = ['#', 'requested (s)', 'name', 'bytes', 'same size', 'via', 'result'];
  const lines = [...info, head.join('\t')];
  const table = document.createElement('table');
  const addRow = (cells, tag = 'td') => {
    const tr = document.createElement('tr');
    for (const c of cells) {
      const cell = document.createElement(tag);
      cell.textContent = c;
      tr.append(cell);
    }
    table.append(tr);
  };
  addRow(head, 'th');
  rows.forEach((r, i) => {
    const result = r.status + (r.reason ? ` — ${r.reason}` : '');
    const cells = [i + 1, r.t ?? '', r.name, r.bytes ? r.bytes.toLocaleString() : '', r.same, r.via, result];
    addRow(cells);
    lines.push(cells.join('\t'));
  });
  det.append(table);

  const copy = document.createElement('button');
  copy.textContent = 'Copy report';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(lines.join('\n'));
    copy.textContent = 'Copied';
  });
  det.append(copy);
  li.append(det);
  $('log').append(li);
}

function confirmSaveAnyway(message) {
  return new Promise(resolve => {
    const li = log(message, 'err');
    const btn = document.createElement('button');
    btn.textContent = 'Save anyway';
    btn.addEventListener('click', () => { btn.disabled = true; resolve(); });
    li.append(document.createElement('br'), btn);
  });
}

// Split mode: one tagged MP3 per chapter, instead of the merged file.
async function addChapterFiles(merged, bitrates, rows) {
  const line = log('Splitting into one MP3 per chapter…');
  if (bitrates.size !== 1 || bitrates.has(0)) {
    throw new Error('The parts do not share one constant bitrate, so they cannot be cut at the chapter times reliably. Nothing was saved.');
  }
  const [bitrate] = bitrates;
  const chapters = rows
    .map((r, i) => ({ title: r.title || `Chapter ${i + 1}`, start: timestampSeconds(r.timestamp) }))
    .filter(c => Number.isFinite(c.start))
    .sort((a, b) => a.start - b.start);
  if (!chapters.length) throw new Error('None of the chapter times could be read. Nothing was saved.');
  if (chapters[0].start > 1) chapters.unshift({ title: 'Opening', start: 0 });
  else chapters[0].start = 0;

  const coverFile = pending.find(f => /^cover\.(jpg|png)$/.test(f.name));
  const cover = coverFile
    ? { bytes: new Uint8Array(await coverFile.blob.arrayBuffer()), mime: coverFile.name.endsWith('png') ? 'image/png' : 'image/jpeg' }
    : null;

  const { files, skipped } = await splitMp3(merged, bitrate, chapters, { album: bookName, cover });
  if (!files.length) throw new Error('No chapter files could be made. Nothing was saved.');
  for (const sk of skipped) log(`Skipped "${sk.title}": ${sk.reason}.`, 'warn');

  const width = Math.max(2, String(files.length).length);
  files.forEach((f, i) => pending.push({
    name: `Chapters/${String(i + 1).padStart(width, '0')} - ${safeFolder(f.title).slice(0, 100)}.mp3`,
    blob: f.blob,
  }));
  line.textContent = `Split into ${files.length} chapter files` + (cover ? ' (tagged, with cover art)' : ' (tagged)');
  line.className = 'ok';
}

async function main() {
  if (!bookName) throw new Error('No book title was given. Enter one in the popup and build again.');
  log(`Book: ${bookName}`);
  pending.push({
    name: 'book.json',
    blob: new Blob([JSON.stringify({ title: bookName }, null, 2)], { type: 'application/json' }),
  });

  const rows = await readChapters();
  if (doSplit && !rows) {
    throw new Error('Splitting into chapters needs the Table of Contents, and it could not be read. Nothing was saved.');
  }
  await readCover();

  let swept = false;
  if (doSweep) {
    await sweepParts();
    swept = true;
  } else {
    log('Chapter sweep is off (checkbox in the popup) — it will run automatically if parts turn out to be missing.', 'warn');
  }

  let found = await collectParts();
  if (found.missing.length && !swept) {
    log(`Part ${found.missing.join(', ')} not loaded yet — running the chapter sweep to load them…`, 'warn');
    await sweepParts();
    swept = true;
    found = await collectParts();
  }
  showReport(found);
  if (found.missing.length) {
    for (const n of found.missing) log(`Part ${n}: ${found.why[n]}`, 'warn');
    const ignored = found.skipped.filter(s => s.includes('duplicate of a named file'));
    if (ignored.length) {
      log(`Ignored as duplicates (same size as a named file): ${ignored.slice(0, 8).join('; ')}` +
        (ignored.length > 8 ? '; …' : ''), 'warn');
    }
    throw new Error(`Part ${found.missing.join(', ')} couldn't be found${swept ? ', even after stepping through the chapters' : ''}, ` +
      'so the book would have a gap. Nothing was saved.');
  }
  const { keep, skipped, dupes, scanning } = found;

  keep.sort((a, b) => nameFor(a.url).localeCompare(nameFor(b.url), undefined, { numeric: true }));
  scanning.textContent = `Found ${keep.length} audio file(s)` +
    (dupes ? `, ignored ${dupes} duplicate copy/copies` : '') +
    (skipped.length - dupes ? `, ignored ${skipped.length - dupes} non-audio` : '') +
    '. Joining in this order:';
  keep.forEach((r, i) => log(`${i + 1}. ${nameFor(r.url)}`));
  if (keep.some(r => !/part\s*\d+/i.test(nameFor(r.url)))) {
    log('Some file names have no "Part N" — double-check the order above.', 'warn');
  }

  const slices = [];
  let seconds = 0;
  const bitrates = new Set();
  const bar = $('bar');
  bar.hidden = false;
  for (let i = 0; i < keep.length; i++) {
    const name = nameFor(keep[i].url);
    const line = log(`Downloading ${i + 1}/${keep.length}…`);
    bar.value = 0;
    const blob = await fetchBlob(keep[i].url, (got, total) => {
      if (total) bar.value = got / total;
      line.textContent = `Downloading ${i + 1}/${keep.length}: ${(got / 1048576).toFixed(0)} MB`;
    });
    const b = await mp3Bounds(blob);
    if (!b) throw new Error(`${name} doesn't look like an MP3. Nothing was saved.`);
    slices.push(blob.slice(b.start, b.end));
    if (b.bitrate) seconds += ((b.end - b.start) * 8) / b.bitrate;
    bitrates.add(b.bitrate);
    line.textContent = `Downloaded ${i + 1}/${keep.length}: ${name}`;
    line.className = 'ok';
  }
  bar.hidden = true;

  const lastStart = rows
    ? Math.max(0, ...rows.map(r => timestampSeconds(r.timestamp)).filter(Number.isFinite))
    : 0;
  if (seconds && lastStart) {
    if (seconds < lastStart - 30) {
      await confirmSaveAnyway(
        `Length check FAILED: the audio is about ${formatDuration(seconds)}, but the last chapter starts at ` +
        `${formatDuration(lastStart)}. Parts are probably missing, so the merged file would be incomplete. ` +
        'Nothing has been saved yet. Close this tab to cancel, or:');
    } else {
      log(`Length check OK: audio is about ${formatDuration(seconds)}; last chapter starts at ${formatDuration(lastStart)}.`, 'ok');
    }
  }
  const mergedBlob = new Blob(slices, { type: 'audio/mpeg' });
  if (doSplit) await addChapterFiles(mergedBlob, bitrates, rows);
  else pending.push({ name: 'audiobook.mp3', blob: mergedBlob });

  // Build complete — now write everything into a folder named after the book.
  const folderName = await uniqueFolder(safeFolder(bookName));
  const saving = log(`Build complete. Saving ${pending.length} files to Downloads/OdioFile/${folderName}…`);
  let firstPath = '';
  for (const file of pending) {
    const blobUrl = URL.createObjectURL(file.blob);
    const path = await saveAndWait({ url: blobUrl, filename: `OdioFile/${folderName}/${file.name}` });
    URL.revokeObjectURL(blobUrl);
    if (!firstPath) firstPath = path;
  }
  const chapterCount = pending.filter(f => f.name.startsWith('Chapters/')).length;
  const others = pending.filter(f => !f.name.startsWith('Chapters/')).map(f => f.name);
  saving.textContent = `Saved ${pending.length} files: ${others.join(', ')}` +
    (chapterCount ? `, plus ${chapterCount} chapter MP3s in the Chapters folder` : '');
  saving.className = 'ok';

  const dir = firstPath.replace(/[\\/][^\\/]*$/, '');
  const done = log('Done. Folder:');
  done.className = 'ok';
  const code = document.createElement('code');
  code.textContent = dir;
  done.append(code);
  if (doSplit) {
    log('The chapter files are in the Chapters folder. The M4B converter needs the merged file, so build again without splitting if you want an M4B.', 'warn');
  } else {
    const next = log('To convert to M4B with chapters, open Terminal in the extension folder (the one containing make_m4b.py) and run:');
    const cmd = document.createElement('code');
    cmd.textContent = `python3 make_m4b.py "${dir}"`;
    next.append(cmd);
  }
}

$('go-player').addEventListener('click', async () => {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
});

main().catch(err => log('Failed: ' + err.message, 'err'));
