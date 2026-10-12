'use strict';
/* global browser, Tesseract, state, category, findItem, addEntries, setStatus, esc, $ */
// Screenshot scanner: reads Warframe inventory screenshots with Tesseract.js (OCR, runs in the browser),
// matches the text on each tile to a warframe.market item, and merges overlapping screenshots.
//
// De-duplication rule: Warframe stacks identical items into one tile with a count, so the same item seen
// in two screenshots is the same tile seen twice. Within one screenshot, tiles of the same item are summed
// (e.g. one mod at two ranks); across screenshots we take the highest per-screenshot total, not the sum.

// Tesseract is bundled with the add-on (extensions may not load code from the internet).
const TESSERACT_DIR = 'vendor/tesseract';
const TESSERACT_URL = `${TESSERACT_DIR}/tesseract.min.js`;
const COUNT_RE = /^[x×]?(\d{1,3}(?:[,.]\d{3})*|\d{1,5})[x×]?$/i;
// Names: sparse text mode finds as much text as possible, in no particular order.
const NAME_PARAMS = { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '', preserve_interword_spaces: '1' };
// Counts: a tile area read as one block of digits.
const COUNT_PARAMS = { tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789x' };
// One name area re-read as a block: far more accurate than the whole-screen pass, which tends to drop letters.
const TILE_PARAMS = { tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' };

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
  const url = (p) => browser.runtime.getURL(`${TESSERACT_DIR}/${p}`);
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: url('worker.min.js'),
    corePath: url('core'),
    langPath: url('lang'),
    workerBlobURL: false, // blob: workers are blocked on extension pages
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

const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Upscales the screenshot and turns every pixel black (text) or white (not text) using isText(r, g, b);
// Tesseract reads black-on-white far better than the game's light-on-dark.
function binarize(img, isText) {
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
    p[i] = p[i + 1] = p[i + 2] = isText(p[i], p[i + 1], p[i + 2]) ? 0 : 255;
  }
  ctx.putImageData(data, 0, 0);
  return { canvas: c, scale };
}

// First pass: anything brighter than the "Text brightness" slider counts as text.
const preprocess = (img, threshold) => binarize(img, (r, g, b) => luminance(r, g, b) >= threshold);

// Second pass: only pixels of the game's text colour (at any brightness, to keep anti-aliased edges).
// Item art is mostly neutral white/grey or a different gold, so this removes most of it.
function preprocessColor(img, color) {
  const cc = color.r * color.r + color.g * color.g + color.b * color.b;
  return binarize(img, (r, g, b) => {
    const t = (r * color.r + g * color.g + b * color.b) / cc; // brightness relative to the text colour
    if (t < 0.55 || t > 1.3) return false;
    const dr = r - t * color.r, dg = g - t * color.g, db = b - t * color.b;
    return dr * dr + dg * dg + db * db <= (12 + 14 * t) ** 2;
  });
}

// Learns the text colour (it depends on the player's UI theme) from names the first pass read confidently:
// inside each name box, the brightest third of the pixels is the lettering.
function estimateTextColor(img, detections) {
  const sure = detections.filter((d) => d.match && d.match.score >= 0.9 && !d.match.ambiguous);
  if (sure.length < 2) return null;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const rs = [], gs = [], bs = [];
  for (const d of sure) {
    const x0 = Math.max(0, Math.floor(d.x0)), y0 = Math.max(0, Math.floor(d.y0));
    const w = Math.min(c.width - x0, Math.ceil(d.x1 - d.x0)), h = Math.min(c.height - y0, Math.ceil(d.y1 - d.y0));
    if (w < 2 || h < 2) continue;
    const px = ctx.getImageData(x0, y0, w, h).data;
    const lums = [];
    for (let i = 0; i < px.length; i += 4) lums.push(luminance(px[i], px[i + 1], px[i + 2]));
    const cut = Math.max(90, [...lums].sort((a, b) => a - b)[Math.floor(lums.length * 0.66)]);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      if (lums[j] >= cut) { rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]); }
    }
  }
  if (rs.length < 150) return null;
  return { r: median(rs), g: median(gs), b: median(bs) };
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

  // 3. A count written right after a name ("Serration x2"). Counts in the tile corner are read by readCounts();
  //    loose digits found elsewhere on the whole screen are usually item art, so they are ignored.
  const detections = clusters.map((c) => {
    const b = box(c.segs.flatMap((s) => s.words));
    return { ...b, segs: c.segs.map((s) => s.words.map((w) => w.text).join(' ')), qty: 1, countBox: null };
  });
  for (const n of counts) {
    if (n.conf < 80) continue;
    const d = detections.find((x) => n.cy > x.y0 && n.cy < x.y1 && n.x0 >= x.x1 - h && n.x0 - x.x1 < h * 2);
    const qty = Number(n.text.replace(/[^0-9]/g, ''));
    if (d && qty > 1) { d.qty = qty; d.countBox = n; d.countText = n.text; }
  }
  return { detections, counts, h };
}

// Tesseract skips lone digits when reading a whole screen, so tile counts get a digits-only pass over the
// upper part of each tile (where stack counts sit). Tile size is estimated from the spacing between names.
// Only a clear, confident number counts; anything else means the tile holds a single item.
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
    if (d.countBox) continue; // already found next to the name
    const left = Math.max(0, cx(d) - W / 2), right = Math.min(imgW, cx(d) + W / 2);
    const tileTop = Math.max(0, d.y1 - H + h);
    const top = tileTop, bottom = Math.min(d.y0 - h * 0.2, tileTop + (d.y0 - tileTop) * 0.4);
    if (bottom - top < h || right - left < h) continue;
    const rectangle = { left: left * scale, top: top * scale, width: (right - left) * scale, height: (bottom - top) * scale };
    const { data } = await worker.recognize(canvas, { rectangle }, { blocks: true });
    const nums = wordsFrom(data)
      .filter((w) => w.confidence >= 80 && COUNT_RE.test(w.text.trim()))
      .filter((w) => { const wh = (w.bbox.y1 - w.bbox.y0) / scale; return wh >= h * 0.6 && wh <= h * 1.8; })
      .sort((a, b) => a.bbox.y0 - b.bbox.y0);
    if (!nums.length) continue;
    const qty = Number(nums[0].text.replace(/[^0-9]/g, ''));
    if (qty > 1) {
      const b = nums[0].bbox;
      d.qty = qty;
      d.countText = `${nums[0].text} (${Math.round(nums[0].confidence)}%)`;
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
    // The inventory shows the same full names as warframe.market ("... Systems Blueprint"), so no
    // shortened variants: "Epitaph Prime" alone must stay unclear, not become "Epitaph Prime Blueprint".
    list.push({ norm: norm(item.name), item });
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
  if (!best || best.score < 0.75) return null; // below this it's screen text like "SELL PRICE", not an item
  // Part of a name that fits several items ("Prime Systems Blueprint" when the first word was lost on the
  // item art) must not be guessed: flag it so the row starts unticked for the player to pick.
  const containing = new Set();
  for (const v of matchIndex()) if (v.norm !== q && v.norm.includes(q)) containing.add(v.item);
  const ambiguous = best.score < 1 && (containing.size >= 2 || best.score - (second?.score ?? 0) < 0.03);
  return { ...best, margin: best.score - (second?.score ?? 0), ambiguous };
}

const letterCount = (s) => (s.match(/[a-z]/gi) || []).length;
const matchQuality = (m) => (m ? m.score - (m.ambiguous ? 0.5 : 0) : -1);

// A name cluster may have picked up a stray line (a badge, a bit of art read as letters); lines with fewer
// than 3 letters are ignored, and the first/last line may be dropped, at a cost so a full reading wins.
function matchDetection(d) {
  const lines = d.segs.filter((s) => letterCount(s) >= 3);
  const tries = [[lines, 0]];
  if (lines.length > 1) tries.push([lines.slice(1), 0.12], [lines.slice(0, -1), 0.12]);
  let best = null;
  for (const [t, penalty] of tries) {
    const m = t.length ? bestMatch(t.join(' ')) : null;
    if (!m) continue;
    m.score -= penalty;
    if (matchQuality(m) > matchQuality(best)) best = m;
  }
  d.text = d.segs.join(' ');
  d.norm = norm(d.text);
  d.match = best;
}

// Re-reads each name area (taller, to catch a first or last line the screen pass missed) as one block,
// and keeps that reading when it matches better.
async function rereadNames(worker, canvas, scale, detections, h) {
  await worker.setParameters(TILE_PARAMS);
  const imgW = canvas.width / scale, imgH = canvas.height / scale;
  for (const d of detections) {
    if (!d.match && letterCount(d.segs.join('')) < 5) continue; // stray letters, not a name
    const padX = (d.x1 - d.x0) * 0.15;
    const r = { x0: Math.max(0, d.x0 - padX), y0: Math.max(0, d.y0 - h * 1.3), x1: Math.min(imgW, d.x1 + padX), y1: Math.min(imgH, d.y1 + h * 1.3) };
    const rectangle = { left: r.x0 * scale, top: r.y0 * scale, width: (r.x1 - r.x0) * scale, height: (r.y1 - r.y0) * scale };
    const { data } = await worker.recognize(canvas, { rectangle });
    const reread = { segs: data.text.split('\n').map((s) => s.trim()).filter(Boolean) };
    matchDetection(reread);
    d.area = r;
    if (matchQuality(reread.match) > matchQuality(d.match)) {
      Object.assign(d, { segs: reread.segs, text: reread.text, norm: reread.norm, match: reread.match });
    }
  }
  // Pieces of one name found separately ("Prime" and "Handle") now read the same tile: keep one.
  const kept = [];
  for (const d of detections) {
    const dup = d.match && kept.some((k) => k.match?.item === d.match.item && k.area && d.area && boxesOverlap(k.area, d.area));
    if (!dup) kept.push(d);
  }
  return kept;
}

function boxesOverlap(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return false;
  return w * h > 0.3 * Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
}

// ---------- scanning ----------

function addShots(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const shot = { id: scan.nextId++, name: file.name || `pasted-${scan.nextId}.png`, file, img: null, status: 'queued', progress: 0, detections: [] };
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

    // Pass 1: brightness threshold.
    let { canvas, scale } = preprocess(shot.img, Number($('#scanThreshold').value));
    const first = await readNames(worker, canvas, scale);
    let { detections, h } = first;

    // Pass 2: keep only the text colour learned from pass 1, which strips most item art, then keep the
    // better reading of every tile from either pass.
    shot.textColor = estimateTextColor(shot.img, first.detections);
    if (shot.textColor) {
      shot.status = 'refining';
      renderShots();
      ({ canvas, scale } = preprocessColor(shot.img, shot.textColor));
      const second = await readNames(worker, canvas, scale);
      detections = mergeDetections([...second.detections, ...first.detections]);
      h = second.h || h;
    }
    shot.processed = canvas;
    detections = await rereadNames(worker, canvas, scale, detections, h);

    shot.status = 'counting';
    renderShots();
    await readCounts(worker, canvas, scale, detections, h); // on the cleanest image, so art isn't read as digits
    shot.detections = detections;
    shot.status = 'done';
  } catch (err) {
    shot.status = 'error';
    shot.error = err.message;
  }
  scan.current = null;
  renderShots();
  aggregate();
}

async function readNames(worker, canvas, scale) {
  await worker.setParameters(NAME_PARAMS);
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const { detections, h } = analyze(wordsFrom(data), scale);
  detections.forEach(matchDetection);
  return { detections, h };
}

// Detections from both passes describe the same tiles; where boxes overlap, keep the better match.
function mergeDetections(all) {
  const kept = [];
  for (const d of [...all].sort((a, b) => matchQuality(b.match) - matchQuality(a.match))) {
    if (!kept.some((k) => boxesOverlap(k, d))) kept.push(d);
  }
  return kept;
}

// ---------- merging screenshots ----------

function aggregate() {
  const groups = new Map();
  for (const shot of scan.shots) {
    for (const d of shot.detections) {
      if (!d.match && d.norm.replace(/ /g, '').length < 6) continue; // short junk text
      const key = d.match ? 'item:' + d.match.item.slug : 'raw:' + d.norm;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, item: d.match?.item ?? null, score: 0, ambiguous: true, perShot: new Map(), texts: new Set() }));
      g.perShot.set(shot.id, (g.perShot.get(shot.id) || 0) + d.qty);
      g.score = Math.max(g.score, d.match?.score ?? 0);
      if (d.match && !d.match.ambiguous) g.ambiguous = false; // one clear reading is enough
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
      ambiguous: edit.slug === undefined && !!g.item && g.ambiguous, // until the player picks an item
      text: [...g.texts].join(' / '),
      checked: edit.checked ?? (!!item && (edit.slug !== undefined || (g.score >= 0.8 && !g.ambiguous))),
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
    if (s.status === 'refining') status = 'reading again…';
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
  const busy = scan.shots.some((s) => ['queued', 'scanning', 'refining', 'counting'].includes(s.status));
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
    const confCls = !r.item || r.ambiguous ? 'bad' : r.score >= 0.85 ? 'good' : r.score >= 0.75 ? 'plat' : 'bad';
    return `<tr data-key="${esc(r.key)}">
      <td><input type="checkbox" data-field="checked"${r.checked ? ' checked' : ''}></td>
      <td><input class="scan-item" list="itemNames" data-field="slug" value="${r.ambiguous ? '' : esc(r.item?.name ?? '')}" placeholder="${r.ambiguous ? 'Which item is this?' : 'Pick the right item…'}"></td>
      <td class="r"><input class="num" type="number" min="1" data-field="qty" value="${r.qty}"></td>
      <td class="muted">${r.shots.map(shotLabel).join(' ')}</td>
      <td class="muted ocr" title="${esc(r.text)}">${esc(r.text)}</td>
      <td class="r ${confCls}"${r.ambiguous ? ' title="Only part of the name was readable and it fits several items"' : ''}>${r.ambiguous ? 'unclear' : r.item ? conf + '%' : '—'}</td>
    </tr>`;
  }).join('');
  const checked = scan.rows.filter((r) => r.checked && r.item && !r.ambiguous);
  const unclear = scan.rows.filter((r) => r.ambiguous).length;
  $('#scanSummary').textContent = `${scan.rows.length - unknown - unclear} matched, ${checked.length} selected` + (unclear ? `, ${unclear} unclear (pick the item)` : '') + (unknown ? `, ${unknown} unrecognised text${unknown === 1 ? '' : 's'}` : '');
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
    const item = row && !row.ambiguous ? row.item : null; // unclear readings stay orange until picked
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
    if (!r.checked || !r.item || r.ambiguous) continue;
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
