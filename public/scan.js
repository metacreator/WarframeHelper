'use strict';
// Screenshot scanner: reads Warframe inventory screenshots with Tesseract.js (OCR, runs in the browser),
// matches the text on each tile to a warframe.market item, and merges overlapping screenshots.
//
// De-duplication rule: Warframe stacks identical items into one tile with a count, so the same item seen
// in two screenshots is the same tile seen twice. Within one screenshot, tiles of the same item are summed
// (e.g. one mod at two ranks); across screenshots we take the highest per-screenshot total, not the sum.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const COUNT_RE = /^[x×]?(\d{1,3}(?:[,.]\d{3})*|\d{1,5})[x×]?$/i;
// Names: sparse text mode finds as much text as possible, in no particular order.
const NAME_PARAMS = { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '', preserve_interword_spaces: '1' };
// Counts: a tile area read as one block of digits.
const COUNT_PARAMS = { tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789x' };

const scan = {
  shots: [],         // { id, name, img, status, progress, detections, counts, processed }
  nextId: 1,
  worker: null,
  queue: Promise.resolve(),
  current: null,     // shot being recognised (for progress)
  previewId: null,
  edits: new Map(),  // row key -> { slug?, qty?, checked? } user corrections, survive re-aggregation
  rows: [],
};

// ---------- loading Tesseract ----------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (scan.worker) return scan.worker;
  if (!window.Tesseract) await loadScript(TESSERACT_URL);
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (scan.current && m.status === 'recognizing text') {
        scan.current.progress = m.progress;
        renderShots();
      }
    },
  });
  scan.worker = worker;
  return worker;
}

// ---------- image prep ----------

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Not an image'));
    img.src = URL.createObjectURL(blob);
  });
}

// Upscale and turn light game text into black-on-white, which Tesseract reads far better.
function preprocess(img, threshold) {
  const w = img.naturalWidth;
  const scale = w <= 1920 ? 2 : w <= 2560 ? 1.5 : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const p = data.data;
  for (let i = 0; i < p.length; i += 4) {
    const lum = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    p[i] = p[i + 1] = p[i + 2] = lum >= threshold ? 0 : 255;
  }
  ctx.putImageData(data, 0, 0);
  return { canvas: c, scale };
}

function wordsFrom(data) {
  if (data.words?.length) return data.words;
  const out = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) out.push(...(l.words ?? []));
  return out;
}

// ---------- layout analysis ----------

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function box(words) {
  return {
    x0: Math.min(...words.map((w) => w.x0)),
    y0: Math.min(...words.map((w) => w.y0)),
    x1: Math.max(...words.map((w) => w.x1)),
    y1: Math.max(...words.map((w) => w.y1)),
  };
}

// Groups words into tile names (one or more stacked lines) and finds the count printed on each tile.
function analyze(rawWords, scale) {
  const words = rawWords
    .map((w) => ({
      text: w.text.trim(),
      conf: w.confidence,
      x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale,
    }))
    .filter((w) => w.text && /[a-z0-9]/i.test(w.text) && w.conf >= 25)
    .map((w) => ({ ...w, h: w.y1 - w.y0, cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2 }));

  const counts = words.filter((w) => COUNT_RE.test(w.text));
  // Short tokens like "A1" (relic names) are kept only when read confidently, to avoid art noise.
  const nameWords = words.filter((w) => !COUNT_RE.test(w.text) && /[a-z]/i.test(w.text) && (/[a-z]{2,}/i.test(w.text) || w.conf >= 60));
  const h = median(nameWords.map((w) => w.h)) || 12;

  // 1. Rows of words sharing a baseline, split into segments at large horizontal gaps (separate tiles).
  const sorted = [...nameWords].sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const w of sorted) {
    const row = rows.find((r) => Math.abs(r.cy - w.cy) < h * 0.6);
    if (row) { row.words.push(w); row.cy = (row.cy * (row.words.length - 1) + w.cy) / row.words.length; }
    else rows.push({ cy: w.cy, words: [w] });
  }
  const segments = [];
  for (const r of rows) {
    r.words.sort((a, b) => a.x0 - b.x0);
    let seg = [r.words[0]];
    for (let i = 1; i < r.words.length; i++) {
      if (r.words[i].x0 - r.words[i - 1].x1 > h * 1.5) { segments.push(seg); seg = []; }
      seg.push(r.words[i]);
    }
    segments.push(seg);
  }
  const segs = segments.map((ws) => ({ words: ws, ...box(ws) })).sort((a, b) => a.y0 - b.y0);

  // 2. Stack segments that sit directly under each other and are centred together: a wrapped name.
  const clusters = [];
  for (const s of segs) {
    const cx = (s.x0 + s.x1) / 2;
    const target = clusters.find((c) => {
      const last = c.segs[c.segs.length - 1];
      const gap = s.y0 - last.y1;
      const lcx = (last.x0 + last.x1) / 2;
      const width = Math.max(last.x1 - last.x0, s.x1 - s.x0);
      return gap > -h * 0.3 && gap < h * 0.9 && Math.abs(cx - lcx) < width * 0.35;
    });
    if (target) target.segs.push(s);
    else clusters.push({ segs: [s] });
  }

  // 3. Attach counts: the closest number above a name (tile corner) or right after it on the same line.
  const detections = clusters.map((c) => {
    const b = box(c.segs.flatMap((s) => s.words));
    return { ...b, segs: c.segs.map((s) => s.words.map((w) => w.text).join(' ')), qty: 1, countBox: null };
  });
  for (const n of counts) {
    let best = null, bestDist = Infinity;
    for (const d of detections) {
      const width = d.x1 - d.x0;
      const sameLine = n.cy > d.y0 && n.cy < d.y1 && n.x0 >= d.x1 - h && n.x0 - d.x1 < h * 2;
      const above = n.cy < d.y0 && d.y0 - n.cy < h * 9 && n.cx > d.x0 - width * 0.6 && n.cx < d.x1 + width * 0.6;
      if (!sameLine && !above) continue;
      const dist = sameLine ? 0 : d.y0 - n.cy + Math.abs(n.cx - (d.x0 + d.x1) / 2) * 0.3;
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    if (best && (!best.countBox || bestDist < best.countDist)) {
      const qty = Number(n.text.replace(/[^0-9]/g, ''));
      if (qty > 0) { best.qty = qty; best.countBox = n; best.countDist = bestDist; }
    }
  }
  return { detections, counts, h };
}

// Tesseract skips lone digits when reading a whole screen, so tile counts get a second, digits-only pass
// over each tile's area above its name. Tile size is estimated from the spacing between names.
async function readCounts(worker, canvas, scale, detections, h) {
  const targets = detections.filter((d) => d.segs.join('').replace(/[^a-z]/gi, '').length >= 4);
  if (!targets.length) return;
  const cx = (d) => (d.x0 + d.x1) / 2;
  const rows = [];
  for (const d of [...targets].sort((a, b) => a.y1 - b.y1)) {
    const row = rows.find((r) => Math.abs(r.y - d.y1) < h * 1.5);
    if (row) row.items.push(d);
    else rows.push({ y: d.y1, items: [d] });
  }
  const gaps = (arr) => arr.sort((a, b) => a - b).map((v, i, a) => v - a[i - 1]).slice(1).filter((g) => g > h * 2);
  const xGaps = rows.flatMap((r) => gaps(r.items.map(cx)));
  const yGaps = gaps(rows.map((r) => r.y));
  const W = xGaps.length ? median(xGaps) : Math.max(...targets.map((d) => d.x1 - d.x0)) * 1.3;
  const H = yGaps.length ? median(yGaps) : W * 1.2;
  const imgW = canvas.width / scale;

  await worker.setParameters(COUNT_PARAMS);
  for (const d of targets) {
    const left = Math.max(0, cx(d) - W / 2), right = Math.min(imgW, cx(d) + W / 2);
    const top = Math.max(0, d.y1 - H + h), bottom = d.y0 - h * 0.2;
    if (bottom - top < h || right - left < h) continue;
    const rectangle = { left: left * scale, top: top * scale, width: (right - left) * scale, height: (bottom - top) * scale };
    const { data } = await worker.recognize(canvas, { rectangle }, { blocks: true });
    const nums = wordsFrom(data)
      .filter((w) => w.confidence >= 60 && COUNT_RE.test(w.text.trim()))
      .sort((a, b) => a.bbox.y0 - b.bbox.y0);
    if (!nums.length) continue;
    const qty = Number(nums[0].text.replace(/[^0-9]/g, ''));
    if (qty > 0) {
      const b = nums[0].bbox;
      d.qty = qty;
      d.countBox = { x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale };
    }
  }
}

// ---------- matching text to items ----------

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

let indexCache = { key: null, list: [] };
function matchIndex() {
  const cat = $('#scanCategory').value;
  if (indexCache.key === cat) return indexCache.list;
  const list = [];
  for (const item of state.items) {
    if (item.tags.includes('set')) continue; // sets aren't inventory items
    if (cat && category(item) !== cat) continue;
    const n = norm(item.name);
    list.push({ norm: n, item });
    // In game, warframe part blueprints may be labelled without "Blueprint", relics without "Relic".
    for (const suffix of [' blueprint', ' relic']) {
      if (n.endsWith(suffix)) list.push({ norm: n.slice(0, -suffix.length), item });
    }
  }
  indexCache = { key: cat, list };
  return list;
}

function bestMatch(text) {
  const q = norm(text);
  if (q.replace(/ /g, '').length < 4) return null;
  let best = null, second = null;
  for (const v of matchIndex()) {
    if (Math.abs(v.norm.length - q.length) > Math.max(4, q.length * 0.4)) continue;
    const score = 1 - levenshtein(q, v.norm) / Math.max(q.length, v.norm.length);
    if (!best || score > best.score) {
      if (best && best.item !== v.item) second = best;
      best = { item: v.item, score };
    } else if (v.item !== best.item && (!second || score > second.score)) {
      second = { item: v.item, score };
    }
  }
  if (!best || best.score < 0.6) return null;
  return { ...best, margin: best.score - (second?.score ?? 0) };
}

// A name cluster may have picked up a stray line (a badge, a stat); try without its first/last line too.
function matchDetection(d) {
  const tries = [d.segs];
  if (d.segs.length > 1) tries.push(d.segs.slice(1), d.segs.slice(0, -1));
  let best = null;
  for (const t of tries) {
    const m = bestMatch(t.join(' '));
    if (m && (!best || m.score > best.score)) best = m;
  }
  d.text = d.segs.join(' ');
  d.norm = norm(d.text);
  d.match = best;
}

// ---------- scanning ----------

function addShots(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const shot = { id: scan.nextId++, name: file.name || `pasted-${scan.nextId}.png`, file, img: null, status: 'queued', progress: 0, detections: [], counts: [] };
    scan.shots.push(shot);
    if (scan.previewId === null) scan.previewId = shot.id;
    enqueue(shot);
  }
  renderShots();
}

function enqueue(shot) {
  shot.status = 'queued';
  scan.queue = scan.queue.then(() => scanShot(shot)).catch(() => {});
}

async function scanShot(shot) {
  if (!scan.shots.includes(shot)) return; // removed while queued
  scan.current = shot;
  shot.status = 'scanning';
  shot.progress = 0;
  renderShots();
  try {
    shot.img ??= await loadImage(shot.file);
    const worker = await getWorker();
    const { canvas, scale } = preprocess(shot.img, Number($('#scanThreshold').value));
    shot.processed = canvas;
    await worker.setParameters(NAME_PARAMS);
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    shot.words = wordsFrom(data); // kept for debugging in the browser console
    const { detections, counts, h } = analyze(shot.words, scale);
    shot.status = 'counting';
    renderShots();
    await readCounts(worker, canvas, scale, detections, h);
    detections.forEach(matchDetection);
    shot.detections = detections;
    shot.counts = counts;
    shot.status = 'done';
  } catch (err) {
    shot.status = 'error';
    shot.error = err.message;
  }
  scan.current = null;
  renderShots();
  aggregate();
}

// ---------- merging screenshots ----------

function aggregate() {
  const groups = new Map();
  for (const shot of scan.shots) {
    for (const d of shot.detections) {
      if (!d.match && d.norm.replace(/ /g, '').length < 6) continue; // short junk text
      const key = d.match ? 'item:' + d.match.item.slug : 'raw:' + d.norm;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, item: d.match?.item ?? null, score: 0, perShot: new Map(), texts: new Set() }));
      g.perShot.set(shot.id, (g.perShot.get(shot.id) || 0) + d.qty);
      g.score = Math.max(g.score, d.match?.score ?? 0);
      g.texts.add(d.text);
    }
  }
  scan.rows = [...groups.values()].map((g) => {
    const edit = scan.edits.get(g.key) || {};
    const item = edit.slug !== undefined ? state.bySlug.get(edit.slug) ?? null : g.item;
    return {
      key: g.key,
      item,
      qty: edit.qty ?? Math.max(...g.perShot.values()),
      shots: [...g.perShot.keys()],
      score: g.score,
      text: [...g.texts].join(' / '),
      checked: edit.checked ?? (!!item && (edit.slug !== undefined || g.score >= 0.8)),
    };
  }).sort((a, b) => (!!b.item - !!a.item) || b.score - a.score || (a.item?.name ?? a.text).localeCompare(b.item?.name ?? b.text));
  renderScanRows();
  renderPreview();
}

// ---------- rendering ----------

function shotLabel(id) { return '#' + (scan.shots.findIndex((s) => s.id === id) + 1); }

function renderShots() {
  $('#shots').innerHTML = scan.shots.map((s, i) => {
    let status = s.status;
    if (s.status === 'scanning') status = `reading ${Math.round(s.progress * 100)}%`;
    if (s.status === 'counting') status = 'reading counts…';
    if (s.status === 'done') status = `${s.detections.filter((d) => d.match).length} items`;
    if (s.status === 'error') status = 'error';
    return `<div class="shot${s.id === scan.previewId ? ' active' : ''}" data-id="${s.id}" title="${esc(s.error || s.name)}">
      <span class="shot-n">#${i + 1}</span>
      <span class="shot-status ${s.status}">${esc(status)}</span>
      <button class="icon" data-action="remove-shot" title="Remove screenshot">✕</button>
    </div>`;
  }).join('');
  $('#scanEmpty').hidden = scan.shots.length > 0;
  $('#scanResults').hidden = scan.shots.length === 0;
  const busy = scan.shots.some((s) => ['queued', 'scanning', 'counting'].includes(s.status));
  $('#scanStatus').textContent = busy
    ? (scan.worker ? 'Reading screenshots…' : 'Loading text recognition (first time takes a few seconds)…')
    : '';
}

function renderScanRows() {
  const showUnknown = $('#scanShowUnknown').checked;
  const rows = scan.rows.filter((r) => r.item || showUnknown);
  const unknown = scan.rows.filter((r) => !r.item).length;
  $('#scanTable tbody').innerHTML = rows.map((r) => {
    const conf = r.item ? Math.round(r.score * 100) : 0;
    const confCls = !r.item ? 'bad' : r.score >= 0.85 ? 'good' : r.score >= 0.75 ? 'plat' : 'bad';
    return `<tr data-key="${esc(r.key)}">
      <td><input type="checkbox" data-field="checked"${r.checked ? ' checked' : ''}></td>
      <td><input class="scan-item" list="itemNames" data-field="slug" value="${esc(r.item?.name ?? '')}" placeholder="Pick the right item…"></td>
      <td class="r"><input class="num" type="number" min="1" data-field="qty" value="${r.qty}"></td>
      <td class="muted">${r.shots.map(shotLabel).join(' ')}</td>
      <td class="muted ocr" title="${esc(r.text)}">${esc(r.text)}</td>
      <td class="r ${confCls}">${r.item ? conf + '%' : '—'}</td>
    </tr>`;
  }).join('');
  const checked = scan.rows.filter((r) => r.checked && r.item);
  $('#scanSummary').textContent = `${scan.rows.length - unknown} matched, ${checked.length} selected` + (unknown ? `, ${unknown} unrecognised text${unknown === 1 ? '' : 's'}` : '');
  $('#scanAdd').disabled = checked.length === 0;
}

function renderPreview() {
  const shot = scan.shots.find((s) => s.id === scan.previewId);
  const canvas = $('#scanPreview');
  if (!shot || !shot.img) { canvas.hidden = true; return; }
  canvas.hidden = false;
  const src = $('#scanProcessed').checked && shot.processed ? shot.processed : shot.img;
  const w = shot.img.naturalWidth, h = shot.img.naturalHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  const lw = Math.max(2, w / 800);
  ctx.lineWidth = lw;
  ctx.font = `${Math.max(12, w / 110)}px system-ui, sans-serif`;
  for (const d of shot.detections) {
    const row = scan.rows.find((r) => r.key === (d.match ? 'item:' + d.match.item.slug : 'raw:' + d.norm));
    const item = row?.item;
    const color = item ? '#5cc98a' : '#e0a050';
    ctx.strokeStyle = color;
    ctx.strokeRect(d.x0 - lw, d.y0 - lw, d.x1 - d.x0 + 2 * lw, d.y1 - d.y0 + 2 * lw);
    if (d.countBox) {
      ctx.strokeStyle = '#6aa8ff';
      const c = d.countBox;
      ctx.strokeRect(c.x0 - lw, c.y0 - lw, c.x1 - c.x0 + 2 * lw, c.y1 - c.y0 + 2 * lw);
    }
    if (item) {
      const label = `${item.name} ×${d.qty}`;
      const tw = ctx.measureText(label).width;
      const lh = parseInt(ctx.font, 10) * 1.3;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(d.x0, d.y1 + lw * 2, tw + 8, lh);
      ctx.fillStyle = color;
      ctx.fillText(label, d.x0 + 4, d.y1 + lw * 2 + lh * 0.78);
    }
  }
}

// ---------- adding to the list ----------

function addScanToList() {
  const bySlug = new Map();
  for (const r of scan.rows) {
    if (!r.checked || !r.item) continue;
    // Two rows resolving to one item are most likely the same tile misread differently: keep the max.
    bySlug.set(r.item.slug, Math.max(bySlug.get(r.item.slug) || 0, r.qty));
  }
  const entries = [...bySlug].map(([slug, qty]) => ({ slug, qty, rank: null, subtype: null }));
  const setQty = $('#scanMode').value === 'set';
  addEntries(entries, { setQty });
  setStatus(`${setQty ? 'Updated' : 'Added'} ${entries.length} items from screenshots.`);
}

// ---------- events ----------

function wireScan() {
  const drop = $('#dropZone');
  drop.addEventListener('click', () => $('#scanFiles').click());
  $('#scanFiles').addEventListener('change', (ev) => { addShots([...ev.target.files]); ev.target.value = ''; });
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    drop.classList.remove('over');
    addShots([...ev.dataTransfer.files]);
  });
  document.addEventListener('paste', (ev) => {
    const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    ev.preventDefault();
    addShots(files);
    $('#scanCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#shots').addEventListener('click', (ev) => {
    const el = ev.target.closest('.shot');
    if (!el) return;
    const id = Number(el.dataset.id);
    if (ev.target.dataset.action === 'remove-shot') {
      scan.shots = scan.shots.filter((s) => s.id !== id);
      if (scan.previewId === id) scan.previewId = scan.shots[0]?.id ?? null;
      renderShots();
      aggregate();
      return;
    }
    scan.previewId = id;
    renderShots();
    renderPreview();
  });

  $('#scanThreshold').addEventListener('input', () => { $('#scanThresholdVal').textContent = $('#scanThreshold').value; });
  $('#scanRescan').addEventListener('click', () => { scan.shots.forEach(enqueue); renderShots(); });
  $('#scanCategory').addEventListener('change', () => {
    for (const s of scan.shots) s.detections.forEach(matchDetection);
    aggregate();
  });
  $('#scanProcessed').addEventListener('change', renderPreview);
  $('#scanPreview').addEventListener('click', () => $('.scan-grid').classList.toggle('big-preview'));
  $('#scanShowUnknown').addEventListener('change', renderScanRows);
  $('#scanClear').addEventListener('click', () => {
    scan.shots = [];
    scan.rows = [];
    scan.edits.clear();
    scan.previewId = null;
    renderShots();
    renderScanRows();
    renderPreview();
  });
  $('#scanAdd').addEventListener('click', addScanToList);

  $('#scanTable tbody').addEventListener('change', (ev) => {
    const field = ev.target.dataset.field;
    const key = ev.target.closest('tr')?.dataset.key;
    if (!field || !key) return;
    const edit = scan.edits.get(key) || {};
    if (field === 'checked') edit.checked = ev.target.checked;
    if (field === 'qty') edit.qty = Math.max(1, Number(ev.target.value) || 1);
    if (field === 'slug') {
      const item = findItem(ev.target.value);
      edit.slug = item ? item.slug : null;
      edit.checked = !!item;
    }
    scan.edits.set(key, edit);
    aggregate();
  });
}

wireScan();
