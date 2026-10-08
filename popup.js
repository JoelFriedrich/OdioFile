const $ = id => document.getElementById(id);
const found = { audio: [] };

function render(kind) {
  const list = found[kind];
  $(`${kind}-count`).textContent = `(${list.length})`;
  $(`${kind}-btn`).disabled = list.length === 0;
  if (kind === 'audio') updateBuildEnabled();
  $(`${kind}-list`).replaceChildren(...list.map(url => {
    const li = document.createElement('li');
    li.textContent = url;
    return li;
  }));
}

async function getTabId() {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
}

let tocRows = null;
let titleEdited = false;

function updateBuildEnabled() {
  $('bundle-btn').disabled = found.audio.length === 0 || !$('title-input').value.trim();
}

async function loadBookInfo(tabId) {
  $('cover-status').textContent = '';
  $('cover').hidden = true;

  // The page's <title> is the book title; prefill it right away, before the slower chapter read.
  const pageTitle = await chrome.tabs.get(tabId).then(t => (t.title || '').trim()).catch(() => '');
  if (!titleEdited && pageTitle) $('title-input').value = pageTitle;
  updateBuildEnabled();

  const [toc, cover] = await Promise.all([
    getToc(tabId).catch(e => ({ error: e.message })),
    getCover(tabId).catch(e => ({ url: '', diag: e.message })),
  ]);

  tocRows = toc.rows || null;
  // No usable page title: fall back to the chapter that starts at 0:00.
  if (!titleEdited && !$('title-input').value.trim() && tocRows) $('title-input').value = bookTitle(tocRows);
  $('title-input').placeholder = 'Enter the book title';
  $('title-input').title = toc.error || '';
  updateBuildEnabled();

  if (cover.url) {
    $('cover').src = cover.url;
    $('cover').hidden = false;
    $('cover-status').textContent = 'Cover found';
  } else {
    $('cover-status').textContent = `Cover not found — ${cover.diag}`;
  }
}

async function exportToc() {
  $('toc-btn').disabled = true;
  $('status').textContent = 'Opening Table of Contents…';
  try {
    const toc = tocRows ? { rows: tocRows } : await getToc(await getTabId());
    if (toc.error) {
      $('status').textContent = toc.error;
      return;
    }
    const rows = toc.rows;
    chrome.downloads.download({
      url: csvDataUrl(tocToCsv(rows)),
      filename: `OdioFile/${timestamp()}/table-of-contents.csv`,
      conflictAction: 'uniquify',
    });
    $('status').textContent = `Saved ${rows.length} chapter(s) → Downloads/OdioFile/…/table-of-contents.csv`;
  } catch (err) {
    $('status').textContent = "Can't read this page: " + err.message;
  } finally {
    $('toc-btn').disabled = false;
  }
}

async function rescan() {
  $('status').textContent = 'Scanning…';
  const tabId = await getTabId();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: scanPage,
    });
    for (const kind of ['audio']) {
      const all = results.flatMap(r => (r.result ? r.result[kind] : []));
      found[kind] = [...new Set(all)].filter(u => /^https?:/i.test(u));
      render(kind);
    }
    $('status').textContent = '';
  } catch (err) {
    $('status').textContent = "Can't scan this page: " + err.message;
    return;
  }
  loadBookInfo(tabId);
}

async function downloadAll(kind) {
  const buttons = [$('audio-btn'), $('bundle-btn')];
  buttons.forEach(b => (b.disabled = true));
  $('status').textContent = 'Checking file types…';

  const folder = `OdioFile/${timestamp()}`;
  const { keep, skipped, dupes } = await selectFiles(kind, found[kind]);

  for (const r of keep) {
    chrome.downloads.download({
      url: r.url,
      filename: `${folder}/${finalName(r.url, kind, r.type)}`,
      conflictAction: 'uniquify',
    });
  }

  if (skipped.length) console.warn('Skipped files:', skipped);
  const notes = [];
  if (dupes) notes.push(`${dupes} duplicate(s)`);
  if (skipped.length - dupes) notes.push(`${skipped.length - dupes} non-${kind}`);
  $('status').textContent = keep.length
    ? `Started ${keep.length} download(s) → Downloads/${folder}` + (notes.length ? ` (skipped ${notes.join(', ')})` : '')
    : `Nothing downloaded — skipped ${skipped.length} file(s).`;
  render('audio');
}

// Merging takes minutes and the popup closes when it loses focus, so it runs in its own tab.
async function openBundle() {
  const params = new URLSearchParams({
    tabId: await getTabId(),
    title: $('title-input').value.trim(),
    sweep: $('sweep').checked ? '1' : '0',
    split: $('split').checked ? '1' : '0',
  });
  chrome.tabs.create({ url: chrome.runtime.getURL(`bundle.html?${params}`) });
}

$('title-input').addEventListener('input', () => {
  titleEdited = true;
  updateBuildEnabled();
});

$('rescan').addEventListener('click', rescan);
$('toc-btn').addEventListener('click', exportToc);
$('bundle-btn').addEventListener('click', openBundle);
$('audio-btn').addEventListener('click', () => downloadAll('audio'));
rescan();
