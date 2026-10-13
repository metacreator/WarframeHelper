'use strict';
/* global browser, Tesseract, Backend, state, category, findItem, addEntries, setStatus, h, fill, $, storageGet, storageSet, t, guessLanguage, itemName, flagPicker, activeTab, showTab, fetchPrice, rowKey, ASSETS, INTL_LOCALE, pageLang */
// Screenshot scanner: reads Warframe inventory screenshots with Tesseract.js (OCR, runs in the browser),
// matches the text on each tile to a warframe.market item, and merges overlapping screenshots.
//
// De-duplication rule: Warframe stacks identical items into one tile with a count, so the same item seen
// in two screenshots is the same tile seen twice. Within one screenshot, tiles of the same item are summed
// (e.g. one mod at two ranks); across screenshots the newest one where a count was visible wins (counts
// change as you trade). A tile without a visible count doesn't override a count seen before: the count may
// just be cut off, so the quantity is assumed unchanged.

// Tesseract is bundled with the add-on (extensions may not load code from the internet).
const TESSERACT_DIR = 'vendor/tesseract';
const TESSERACT_URL = `${TESSERACT_DIR}/tesseract.min.js`;
const COUNT_RE = /^[x×]?(\d{1,3}(?:[,.]\d{3})*|\d{1,5})[x×]?$/i;
// Tesseract settings. Each set is complete, as a worker keeps whatever was set last. The images are always
// black text on white, so Tesseract isn't asked to try unsure lines inverted as well (do_invert), which saves time.
// Names: sparse text mode finds as much text as possible, in no particular order.
const NAME_PARAMS = { tessedit_do_invert: '0', tessedit_pageseg_mode: '11', tessedit_char_whitelist: '', preserve_interword_spaces: '1' };
// Counts: a tile area read as one block of digits.
const COUNT_PARAMS = { tessedit_do_invert: '0', tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789x', preserve_interword_spaces: '0' };
// One name area re-read as a block: far more accurate than the whole-screen pass, which tends to drop letters.
const TILE_PARAMS = { tessedit_do_invert: '0', tessedit_pageseg_mode: '6', tessedit_char_whitelist: '', preserve_interword_spaces: '1' };

// Languages the game can be in. ocr: Tesseract language data in vendor/tesseract/lang. Item names in that
// language come from warframe.market, which uses the game's own translations.
const GAME_LANGS = {
  en: { label: 'English', ocr: 'eng' },
  uk: { label: 'Українська', ocr: 'ukr' },
  es: { label: 'Español', ocr: 'spa' },
  'zh-hans': { label: '简体中文', ocr: 'chi_sim' },
  'zh-hant': { label: '繁體中文', ocr: 'chi_tra' },
};

// Relic refinement words in every supported language. A refined relic is its own tile, and its refinement
// is read when it's printed with the name. Without it the relic is taken as Intact (warframe.market's default).
const REFINEMENTS = {
  intact: ['intact', 'intacta', 'intacto', 'ціла', 'цілісна', 'неушкоджена', '完整'],
  exceptional: ['exceptional', 'excepcional', 'виняткова', '优良', '優良'],
  flawless: ['flawless', 'impecable', 'бездоганна', '无暇', '無瑕'],
  radiant: ['radiant', 'radiante', 'сяйна', 'сяюча', 'променева', '光辉', '光輝'],
};

// Two screenshots are read at the same time on computers with enough cores (their reading shares the OCR workers).
const POOL_SIZE = Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

const scan = {
  shots: [],         // { id, name, img, status, progress, detections, processed, seconds, timings }
  nextId: 1,
  pending: [],       // shots waiting for a free worker
  busy: [],          // per slot: shot being read (for progress)
  lang: 'en',
  names: null,       // { slug: name } in the game language; null = English
  namesPromise: null,
  previewId: null,
  edits: new Map(),  // row key -> { slug?, qty?, subtype?, checked? } user corrections, survive re-aggregation
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

let tesseractLoaded = null;

async function createWorker(ocr, logger) {
  tesseractLoaded ??= window.Tesseract ? Promise.resolve() : loadScript(TESSERACT_URL);
  await tesseractLoaded;
  const url = (p) => browser.runtime.getURL(`${TESSERACT_DIR}/${p}`);
  return Tesseract.createWorker(ocr, 1, {
    workerPath: url('worker.min.js'),
    corePath: url('core'),
    langPath: url('lang'),
    workerBlobURL: false, // blob: workers are blocked on extension pages
    ...(logger ? { logger } : {}),
  });
}

// A copy of a prepared image with the names already read exactly painted over: reading them again can't improve
// them, and Tesseract's time goes mostly into the text it finds. (Relics stay: their refinement may be missing.)
function withoutSureNames(canvas, scale, detections, textH) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  ctx.fillStyle = '#fff';
  const pad = textH * 0.3;
  for (const d of detections) {
    if (matchQuality(d.match) < 1 || d.match.item.subtypes) continue;
    ctx.fillRect((d.x0 - pad) * scale, (d.y0 - pad) * scale, (d.x1 - d.x0 + 2 * pad) * scale, (d.y1 - d.y0 + 2 * pad) * scale);
  }
  return copy;
}

// ---------- OCR workers ----------

// Tesseract workers are pooled per language data, and shared by everything being read: a screenshot is read in
// bands side by side, and name re-reads and count reads run in parallel. Stack counts use the English data in
// every game language: digits read best with it (the Ukrainian one takes a 3 for a З). Workers start on first
// use and stop after a while without work, which frees their memory.
const OCR_WORKERS = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
const POOL_IDLE_MS = 10 * 60 * 1000;
const pools = new Map(); // ocr -> { ocr, size, workers: [{ worker (promise), busy, params, onProgress }], waiting, timer }

function getPool(ocr, size) {
  if (!pools.has(ocr)) pools.set(ocr, { ocr, size, workers: [], waiting: [], timer: null });
  const pool = pools.get(ocr);
  pool.size = Math.max(pool.size, size);
  return pool;
}

function startWorker(pool) {
  const entry = { busy: true, params: null, onProgress: null };
  entry.worker = createWorker(pool.ocr, (m) => { if (m.status === 'recognizing text') entry.onProgress?.(m.progress); });
  entry.worker.catch(() => {}); // a worker that failed to start is replaced when a job finds out
  pool.workers.push(entry);
  return entry;
}

function acquire(pool) {
  clearTimeout(pool.timer);
  const free = pool.workers.find((w) => !w.busy);
  if (free) { free.busy = true; return Promise.resolve(free); }
  if (pool.workers.length < pool.size) return Promise.resolve(startWorker(pool));
  return new Promise((resolve) => pool.waiting.push(resolve));
}

function release(pool, entry, broken) {
  if (broken) { // not reused: the next job gets a fresh one
    pool.workers.splice(pool.workers.indexOf(entry), 1);
    entry.worker.then((w) => w.terminate()).catch(() => {});
  }
  const next = pool.waiting.shift();
  if (next) { next(broken ? startWorker(pool) : entry); return; }
  entry.busy = false;
  stopWhenIdle(pool);
}

function stopWhenIdle(pool) {
  if (pool.workers.some((w) => w.busy)) return;
  clearTimeout(pool.timer);
  pool.timer = setTimeout(() => {
    pools.delete(pool.ocr);
    for (const w of pool.workers) w.worker.then((wk) => wk.terminate()).catch(() => {});
  }, POOL_IDLE_MS);
}

// Starts the workers ahead of a screenshot (a screen shared, a file dragged over the page), so that reading it
// doesn't wait for them. They stop again if nothing comes.
function warmUp() {
  const wanted = [getPool(GAME_LANGS[scan.lang].ocr, OCR_WORKERS), getPool('eng', scan.lang === 'en' ? OCR_WORKERS : 2)];
  for (const pool of wanted) {
    while (pool.workers.length < pool.size) startWorker(pool).busy = false;
    stopWhenIdle(pool);
  }
}

// Reads one image with a worker for that language data, with these settings. Returns Tesseract's result data.
async function ocrJob(ocr, image, params, output, onProgress, size = OCR_WORKERS) {
  const pool = getPool(ocr, size);
  const entry = await acquire(pool);
  let broken = false;
  try {
    const worker = await entry.worker;
    if (entry.params !== params) { await worker.setParameters(params); entry.params = params; }
    entry.onProgress = onProgress;
    return (await worker.recognize(image, {}, output)).data;
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    entry.onProgress = null;
    release(pool, entry, broken);
  }
}

// Stack counts: English data, at most two workers of their own when the game is in another language.
const readCount = (image) => ocrJob('eng', image, COUNT_PARAMS, { blocks: true }, null, scan.lang === 'en' ? OCR_WORKERS : 2);

function setLanguage(lang) {
  scan.lang = GAME_LANGS[lang] ? lang : 'en';
  scan.names = null;
  scan.namesPromise = null;
}

async function ensureNames() {
  if (scan.lang === 'en') { scan.names = null; return; }
  scan.namesPromise ??= Backend.getItemNames(scan.lang);
  try {
    scan.names = await scan.namesPromise;
  } catch (err) {
    scan.namesPromise = null; // try again with the next screenshot
    throw new Error(t('Could not load {lang} item names: {error}', { lang: GAME_LANGS[scan.lang].label, error: t(err.message) }));
  }
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
function binarize(img, isText, scale = img.naturalWidth <= 1920 ? 2 : img.naturalWidth <= 2560 ? 1.5 : 1) {
  const w = img.naturalWidth;
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

// Third pass, for mod cards (the Mods screen, reward choices): their names are white over bright card art.
// Only light, colourless pixels are kept (the art is gold), enlarged a bit more, and read as one block, which
// copes better with leftover bits of art than the sparse mode used for whole inventory screens.
const isWhiteText = (r, g, b) => luminance(r, g, b) >= 185 && Math.max(r, g, b) - Math.min(r, g, b) <= 75;
const BLOCK_PARAMS = { tessedit_do_invert: '0', tessedit_pageseg_mode: '6', tessedit_char_whitelist: '', preserve_interword_spaces: '1' };

// Learns the text colour (it depends on the player's UI theme) from names the first pass read confidently:
// inside each name box, the brightest third of the pixels is the lettering. One such name is enough (a reward
// screen has only a few); the colour pass only replaces readings it improves on.
function estimateTextColor(img, detections) {
  const sure = detections.filter((d) => d.match && d.match.score >= 0.9 && !d.match.ambiguous);
  if (!sure.length) return null;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const rs = [], gs = [], bs = [];
  for (const d of sure) {
    const x0 = Math.max(0, Math.floor(d.x0)), y0 = Math.max(0, Math.floor(d.y0));
    const w = Math.min(c.width - x0, Math.ceil(d.x1 - d.x0)), ht = Math.min(c.height - y0, Math.ceil(d.y1 - d.y0));
    if (w < 2 || ht < 2) continue;
    const px = ctx.getImageData(x0, y0, w, ht).data;
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

// ---------- text helpers (any script) ----------

const HAN = /\p{Script=Han}/u;

// How much readable text a string holds. A Chinese character carries about as much as three letters.
function textWeight(s, withDigits = false) {
  let n = 0;
  for (const c of s) {
    if (HAN.test(c)) n += 3;
    else if (/\p{L}/u.test(c) || (withDigits && /\p{N}/u.test(c))) n += 1;
  }
  return n;
}

// Cyrillic letters that look like Latin ones: OCR mixes them up (the "A1" in "Реліквія Літ A1" is Latin).
const LOOKALIKE = { а: 'a', в: 'b', е: 'e', і: 'i', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' };

// Comparable form of a name: lower case, no accents or punctuation, lookalike letters unified, and no spaces
// next to Chinese characters (OCR puts spaces between them that the real name doesn't have).
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/[авеікмнорстух]/g, (c) => LOOKALIKE[c])
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  .replace(/\s+(?=\p{Script=Han})|(?<=\p{Script=Han})\s+/gu, '');

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
    .filter((w) => w.text && /[\p{L}\p{N}]/u.test(w.text) && w.conf >= 25)
    .map((w) => ({ ...w, h: w.y1 - w.y0, cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2 }));

  const counts = words.filter((w) => COUNT_RE.test(w.text));
  // Short tokens like "A1" (relic names) are kept only when read confidently, to avoid art noise; the same
  // goes for single Chinese characters, which item art is often mistaken for.
  const nameWords = words.filter((w) => !COUNT_RE.test(w.text) && /\p{L}/u.test(w.text)
    && (HAN.test(w.text) ? w.conf >= 30 : /\p{L}{2,}/u.test(w.text) || w.conf >= 60));
  const textH = median(nameWords.map((w) => w.h)) || 12;

  // 1. Rows of words sharing a baseline, split into segments at large horizontal gaps (separate tiles).
  const sorted = [...nameWords].sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const w of sorted) {
    const row = rows.find((r) => Math.abs(r.cy - w.cy) < textH * 0.6);
    if (row) { row.words.push(w); row.cy = (row.cy * (row.words.length - 1) + w.cy) / row.words.length; }
    else rows.push({ cy: w.cy, words: [w] });
  }
  const segments = [];
  for (const r of rows) {
    r.words.sort((a, b) => a.x0 - b.x0);
    let seg = [r.words[0]];
    for (let i = 1; i < r.words.length; i++) {
      if (r.words[i].x0 - r.words[i - 1].x1 > textH * 1.5) { segments.push(seg); seg = []; }
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
      return gap > -textH * 0.3 && gap < textH * 0.9 && Math.abs(cx - lcx) < width * 0.35;
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
    const d = detections.find((x) => n.cy > x.y0 && n.cy < x.y1 && n.x0 >= x.x1 - textH && n.x0 - x.x1 < textH * 2);
    const qty = Number(n.text.replace(/[^0-9]/g, ''));
    if (d && qty > 1) { d.qty = qty; d.countBox = n; d.countText = n.text; }
  }
  return { detections, counts, textH };
}

// Groups nearby values (tile centres along one axis) and returns the centre of each group, in order.
function groupValues(values, gap) {
  const groups = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && v - last[last.length - 1] <= gap) last.push(v);
    else groups.push([v]);
  }
  return groups.map(median);
}

const nearestIndex = (centres, v) => centres.reduce((best, c, i) => (Math.abs(c - v) < Math.abs(centres[best] - v) ? i : best), 0);

// The first pass alone is enough when every name it found is a confident match and those names fill a grid
// with no gaps (a gap is a tile whose name wasn't read). Otherwise the colour pass looks for what's missing.
function looksComplete(detections, textH) {
  const named = detections.filter((d) => d.match && !d.match.ambiguous && d.match.score >= 0.9);
  if (named.length < 4) return false;
  const area = {
    x0: Math.min(...named.map((d) => d.x0)) - textH, x1: Math.max(...named.map((d) => d.x1)) + textH,
    y0: Math.min(...named.map((d) => d.y0)) - textH, y1: Math.max(...named.map((d) => d.y1)) + textH,
  };
  const inGrid = (d) => { const cx = (d.x0 + d.x1) / 2, cy = (d.y0 + d.y1) / 2; return cx > area.x0 && cx < area.x1 && cy > area.y0 && cy < area.y1; };
  // Text among the tiles that isn't a clear item name is a name the first pass couldn't read properly.
  if (detections.some((d) => !named.includes(d) && textWeight(d.segs.join('')) >= 5 && inGrid(d))) return false;

  const cx = (d) => (d.x0 + d.x1) / 2;
  const cols = groupValues(named.map(cx), textH * 3);
  const rows = groupValues(named.map((d) => d.y1), textH * 3);
  const cells = new Set(named.map((d) => `${nearestIndex(rows, d.y1)}:${nearestIndex(cols, cx(d))}`));
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      if (cells.has(`${r}:${c}`)) continue;
      // Only the last row may end early (the end of the inventory).
      const laterInRow = cols.some((_, k) => k > c && cells.has(`${r}:${k}`));
      if (r < rows.length - 1 || laterInRow) return false;
    }
  }
  return true;
}

// Tesseract.js re-encodes the whole image on every call, even to read a small area, so small areas are cut
// out first (with a white margin, as text touching the edge reads worse). Word boxes come back in screenshot
// coordinates. r is in screenshot pixels; the canvas is the upscaled, black-on-white one. read(image, output)
// runs the OCR job.
const CROP_MARGIN = 8;
async function recognizeArea(read, canvas, scale, r, output) {
  const w = Math.max(1, Math.round((r.x1 - r.x0) * scale)), ht = Math.max(1, Math.round((r.y1 - r.y0) * scale));
  const c = document.createElement('canvas');
  c.width = w + 2 * CROP_MARGIN;
  c.height = ht + 2 * CROP_MARGIN;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, Math.round(r.x0 * scale), Math.round(r.y0 * scale), w, ht, CROP_MARGIN, CROP_MARGIN, w, ht);
  const data = await read(c, output);
  const toShot = (b) => ({ x0: r.x0 + (b.x0 - CROP_MARGIN) / scale, y0: r.y0 + (b.y0 - CROP_MARGIN) / scale, x1: r.x0 + (b.x1 - CROP_MARGIN) / scale, y1: r.y0 + (b.y1 - CROP_MARGIN) / scale });
  return { text: data.text, words: output?.blocks ? wordsFrom(data).map((wd) => ({ text: wd.text, confidence: wd.confidence, box: toShot(wd.bbox) })) : [] };
}

// Tesseract skips lone digits when reading a whole screen, so tile counts get a digits-only pass over the
// upper part of each tile (where stack counts sit). Tile size is estimated from the spacing between names.
// Only a clear, confident number counts; anything else means the tile holds a single item.
async function readCounts(canvas, scale, detections, textH) {
  const targets = detections.filter((d) => textWeight(d.segs.join('')) >= 4);
  if (!targets.length) return;
  const cx = (d) => (d.x0 + d.x1) / 2, cy = (d) => (d.y0 + d.y1) / 2;
  // Rows of tiles: names in one row may have one to three lines, so they're grouped by centre, generously.
  const rowCentres = groupValues(targets.map(cy), textH * 3);
  const rows = rowCentres.map(() => []);
  for (const d of targets) rows[nearestIndex(rowCentres, cy(d))].push(d);
  const gaps = (arr) => [...arr].sort((a, b) => a - b).map((v, i, a) => v - a[i - 1]).slice(1).filter((g) => g > textH * 2);
  const xGaps = rows.flatMap((r) => gaps(r.map(cx)));
  const yGaps = gaps(rowCentres);
  const W = xGaps.length ? median(xGaps) : Math.max(...targets.map((d) => d.x1 - d.x0)) * 1.3;
  const H = yGaps.length ? median(yGaps) : W * 1.2;
  const imgW = canvas.width / scale;

  // Every tile is read at the same time (each on its own; the workers share them out).
  await Promise.all(rows.flatMap((row) => {
    // Every tile in a row ends at the same height, just under its lowest name line.
    const rowBottom = Math.max(...row.map((d) => d.y1));
    return row.map(async (d) => {
      if (d.countBox) return; // already found next to the name
      const left = Math.max(0, cx(d) - W / 2), right = Math.min(imgW, cx(d) + W / 2);
      const tileTop = Math.max(0, rowBottom - H + textH);
      const top = tileTop, bottom = Math.min(d.y0 - textH * 0.2, tileTop + (d.y0 - tileTop) * 0.4);
      if (bottom - top < textH || right - left < textH) return;
      const { words } = await recognizeArea(readCount, canvas, scale, { x0: left, y0: top, x1: right, y1: bottom }, { blocks: true });
      const nums = words
        .filter((w) => w.confidence >= 80 && COUNT_RE.test(w.text.trim()))
        .filter((w) => { const wh = w.box.y1 - w.box.y0; return wh >= textH * 0.6 && wh <= textH * 1.8; })
        .sort((a, b) => a.box.y0 - b.box.y0);
      if (!nums.length) return;
      const qty = Number(nums[0].text.replace(/[^0-9]/g, ''));
      if (qty > 1) {
        d.qty = qty;
        d.countText = `${nums[0].text} (${Math.round(nums[0].confidence)}%)`;
        d.countBox = nums[0].box;
      }
    });
  }));
}

// ---------- matching text to items ----------

// Edit distance between a and b. Gives up (Infinity) once every way through has cost stop or more: the caller
// then knows the distance is at least stop. Two reused rows keep it from allocating.
let levPrev = new Int32Array(64), levCur = new Int32Array(64);
function levenshtein(a, b, stop = Infinity) {
  if (a === b) return 0;
  const n = b.length;
  if (levPrev.length <= n) { levPrev = new Int32Array(n * 2 + 1); levCur = new Int32Array(n * 2 + 1); }
  let prev = levPrev, cur = levCur;
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin >= stop) return Infinity;
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Relic rewards that warframe.market doesn't trade. A quick price check shows them as such rather than leaving
// them out (a reward screen often has a Forma Blueprint); the list scanner never adds them.
const NOT_ON_MARKET = ['Forma Blueprint', 'Exilus Weapon Adapter Blueprint', 'Riven Sliver'].map((name) => ({
  slug: name.toLowerCase().replace(/ /g, '_'), name, tags: [], maxRank: null, ducats: null, subtypes: null, thumb: null, notOnMarket: true,
}));

// cat: the "Looking for" category ('' = any item; 'quick' = any item, plus the rewards above). Kept per
// category, as two screenshots may be read at once.
const indexCache = new Map();
const indexKey = (cat) => `${cat}|${scan.lang}|${!!scan.names}`;
function matchIndex(cat) {
  const key = indexKey(cat);
  if (indexCache.has(key)) return indexCache.get(key);
  const list = [];
  for (const item of state.items) {
    if (item.tags.includes('set')) continue; // sets aren't inventory items
    if (cat && cat !== 'quick' && category(item) !== cat) continue;
    // The inventory shows the same full names as warframe.market ("... Systems Blueprint"), so no
    // shortened variants: "Epitaph Prime" alone must stay unclear, not become "Epitaph Prime Blueprint".
    list.push({ norm: norm(scan.names?.[item.slug] ?? item.name), item });
  }
  if (cat === 'quick') for (const item of NOT_ON_MARKET) list.push({ norm: norm(item.name), item });
  indexCache.set(key, list);
  return list;
}

// The same text comes up again and again (every pass and re-read reads most names), so results are remembered
// per item list. Callers adjust the result they get, so each gets its own copy.
const matchCache = new Map(); // indexKey -> Map(normalised text -> result)
function bestMatch(text, cat) {
  const q = norm(text);
  if (textWeight(q, true) < 4) return null;
  const key = indexKey(cat);
  if (!matchCache.has(key) || matchCache.get(key).size > 20000) matchCache.set(key, new Map());
  const cache = matchCache.get(key);
  if (!cache.has(q)) cache.set(q, findBestMatch(q, cat));
  const found = cache.get(q);
  return found && { ...found };
}

// Smallest distance d at which a name of length len scores 1 - d / len <= floor, i.e. can't change anything.
function stopDistance(floor, len) {
  if (floor === -Infinity) return Infinity;
  let d = Math.max(0, Math.ceil((1 - floor) * len) - 1);
  while (1 - d / len > floor) d++;
  return d;
}

function findBestMatch(q, cat) {
  let best = null, second = null;
  for (const v of matchIndex(cat)) {
    if (Math.abs(v.norm.length - q.length) > Math.max(4, q.length * 0.4)) continue;
    // Only a score above this can change best or second, so the distance is worked out no further than that.
    const floor = best && v.item === best.item ? best.score : (second?.score ?? -Infinity);
    const len = Math.max(q.length, v.norm.length);
    const score = 1 - levenshtein(q, v.norm, stopDistance(floor, len)) / len;
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
  // The same goes when the reading without its first or last character does: that character may be all
  // that's left of the distinctive part ("5 Prime 刀刃" when 翁 or 关刀 was lost, as many names end "Prime 刀刃").
  const fitsSeveral = (part) => {
    const containing = new Set();
    for (const v of matchIndex(cat)) if (v.norm !== q && v.norm.includes(part)) containing.add(v.item);
    return containing.size >= 2;
  };
  const cores = [q.slice(1).trim(), q.slice(0, -1).trim()].filter((c) => textWeight(c, true) >= 4);
  const ambiguous = best.score < 1 && (fitsSeveral(q) || cores.some(fitsSeveral) || best.score - (second?.score ?? 0) < 0.03);
  return { ...best, margin: best.score - (second?.score ?? 0), ambiguous };
}

let refinementWords = null;

// Finds a refinement word in one line of text: { subtype, rest } (rest = the line without it), or null.
function findRefinement(line) {
  refinementWords ??= Object.entries(REFINEMENTS).flatMap(([subtype, words]) => words.map((w) => ({ subtype, word: norm(w) })));
  const n = norm(line);
  for (const { subtype, word } of refinementWords) {
    if (HAN.test(word)) {
      if (n.includes(word)) return { subtype, rest: n.replace(word, ' ').trim() };
      // Only its first character read, right after the name (relic names end in 遗物, so nothing else ends so)
      if (n.length > 2 && n.endsWith(word[0])) return { subtype, rest: n.slice(0, -1) };
      continue;
    }
    const tokens = n.split(' ');
    const allowed = word.length < 6 ? 0 : word.length < 9 ? 1 : 2; // OCR slips in longer words
    // Brackets around the word are often read as letters ("[СЯЙНА]" as "ІСЯЙНАЇ"), so it may sit inside a token.
    const i = tokens.findIndex((t) => t.length >= 4 && (t.includes(word) || levenshtein(t, word) <= allowed));
    if (i >= 0) { tokens.splice(i, 1); return { subtype, rest: tokens.join(' ') }; }
  }
  return null;
}

const matchQuality = (m) => (m ? m.score - (m.ambiguous ? 0.5 : 0) : -1);
// A reading wins if it matches better, or equally well but also found the relic's refinement.
const isBetter = (a, b) => matchQuality(a) > matchQuality(b) || (!!a && !!b && matchQuality(a) === matchQuality(b) && !!a.subtype && !b.subtype);

// A name cluster may have picked up a stray line (a badge, a bit of art read as letters); lines with fewer
// than 3 letters are ignored, and the first/last line may be dropped, at a cost so a full reading wins.
// A refinement word ("Radiant") is tried both as part of the name and removed, since some item names
// contain such words ("Radiant Finish"); it only counts for relics.
function matchDetection(d, cat = $('#scanCategory').value) {
  const lines = d.segs.filter((s) => textWeight(s) >= 3);
  let subtype = null;
  const stripped = lines.map((l) => {
    const found = findRefinement(l);
    if (!found) return l;
    subtype ??= found.subtype;
    return found.rest;
  }).filter((l) => textWeight(l) >= 3);
  const variants = subtype ? [[lines, null], [stripped, subtype]] : [[lines, null]];
  let best = null;
  for (const [ls, sub] of variants) {
    const tries = [[ls, 0]];
    if (ls.length > 1) tries.push([ls.slice(1), 0.12], [ls.slice(0, -1), 0.12]);
    for (const [t, penalty] of tries) {
      const m = t.length ? bestMatch(t.join(' '), cat) : null;
      if (!m) continue;
      if (sub && !m.item.subtypes?.includes(sub)) continue;
      m.score -= penalty;
      m.subtype = sub;
      if (isBetter(m, best)) best = m;
    }
  }
  d.text = d.segs.join(' ');
  d.norm = norm(d.text);
  d.match = best;
}

// Re-reads each name area (taller, to catch a first or last line the screen pass missed) as one block,
// and keeps that reading when it matches better. Within each step, all areas are read at the same time and the
// readings then applied in order, exactly as if they had been read one after another.
async function rereadNames(ocr, canvas, scale, detections, textH, cat) {
  const imgW = canvas.width / scale, imgH = canvas.height / scale;
  const readTile = (image, output) => ocrJob(ocr, image, TILE_PARAMS, output);
  // Area around a box, padX to each side; reads it on the image the detection came from.
  const around = (b, padX) => ({ x0: Math.max(0, b.x0 - padX), y0: Math.max(0, b.y0 - textH * 1.3), x1: Math.min(imgW, b.x1 + padX), y1: Math.min(imgH, b.y1 + textH * 1.3) });
  const readArea = async (d, r) => {
    const src = d.source ?? { canvas, scale };
    const { text } = await recognizeArea(readTile, src.canvas, src.scale, r);
    const reading = { segs: text.split('\n').map((s) => s.trim()).filter(Boolean) };
    matchDetection(reading, cat);
    return reading;
  };
  const weak = (d) => (!d.match || d.match.ambiguous) && textWeight(d.segs.join('')) >= 3;
  // Readings started ahead that may turn out not to be needed: a failure counts only if it's awaited.
  const ahead = (p) => { p.catch(() => {}); return p; };

  // 1. Every name, read again as a block in a slightly wider area (taller, to catch a missed first or last line).
  const step1 = detections.filter((d) => d.match || textWeight(d.segs.join('')) >= 5); // else stray letters, not a name
  for (const d of step1) d.area = around(d, (d.x1 - d.x0) * 0.15);
  // An exact, clear match can't be improved on, so it isn't read again (relics are, for a refinement line).
  const toReread = step1.filter((d) => !(matchQuality(d.match) >= 1 && !d.match.item.subtypes));
  const rereads = await Promise.all(toReread.map((d) => readArea(d, d.area)));
  toReread.forEach((d, i) => {
    const reread = rereads[i];
    if (isBetter(reread.match, d.match)) Object.assign(d, { segs: reread.segs, text: reread.text, norm: reread.norm, match: reread.match });
  });

  // 2. A name whose middle wasn't read falls apart into two pieces side by side. Two unclear pieces on one line
  //    are read again together, and replaced by that reading only if it's a clear match.
  const pairs = [];
  for (const a of detections) {
    for (const b of detections) {
      if (a === b || !weak(a) || !weak(b)) continue;
      const gap = b.x0 - a.x1;
      if (gap <= 0 || gap > textH * 4 || Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) > textH) continue;
      const u = box([a, b]);
      const r = around(u, textH);
      pairs.push({ a, b, u, r, reading: ahead(readArea(a, r)) });
    }
  }
  for (const { a, b, u, r, reading } of pairs) {
    if (a.joined || b.joined) continue;
    const joined = { ...u, ...(await reading), qty: 1, countBox: null, area: r, source: a.source };
    if (joined.match && !joined.match.ambiguous && joined.match.score >= 0.8) {
      a.joined = b.joined = true;
      detections.push(joined);
    }
  }

  // 3. A piece that's still unclear may be all that was read of a longer name ("Seqlence" when "Toxic" was lost
  //    on the card art): it's read once more with as much room again on each side. A clear match takes over the
  //    unclear pieces in that strip, and its box grows to cover them, so its count is looked for in the right tile.
  const step3 = detections.filter((d) => !d.joined && weak(d) && textWeight(d.segs.join('')) >= 5)
    .map((d) => { const r = around(d, d.x1 - d.x0); return { d, r, reading: ahead(readArea(d, r)) }; });
  for (const { d, r, reading } of step3) {
    if (d.joined) continue; // taken over by an earlier piece's reading
    const reread = await reading;
    if (!reread.match || reread.match.ambiguous || !isBetter(reread.match, d.match)) continue;
    const inStrip = (o) => o !== d && !o.joined && weak(o) && (o.x0 + o.x1) / 2 > r.x0 && (o.x0 + o.x1) / 2 < r.x1
      && Math.abs((o.y0 + o.y1) / 2 - (d.y0 + d.y1) / 2) < textH;
    for (const o of detections.filter(inStrip)) {
      o.joined = true;
      Object.assign(d, { x0: Math.min(d.x0, o.x0), y0: Math.min(d.y0, o.y0), x1: Math.max(d.x1, o.x1), y1: Math.max(d.y1, o.y1) });
    }
    Object.assign(d, { segs: reread.segs, text: reread.text, norm: reread.norm, match: reread.match, area: r });
  }
  detections = detections.filter((d) => !d.joined);

  // Pieces of one name found separately ("Prime" and "Handle") now read the same tile: keep one.
  const kept = [];
  for (const d of detections) {
    const dup = d.match && kept.some((k) => k.match?.item === d.match.item && k.area && d.area && boxesOverlap(k.area, d.area));
    if (!dup) kept.push(d);
  }
  return kept;
}

function boxesOverlap(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), ht = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || ht <= 0) return false;
  return w * ht > 0.3 * Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
}

// ---------- scanning ----------

function addShots(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    // When it was taken: files keep their time; pasted screenshots get the time they were pasted.
    const shot = { id: scan.nextId++, name: file.name || `pasted-${scan.nextId}.png`, file, time: file.lastModified || Date.now(), img: null, status: 'queued', progress: 0, detections: [] };
    scan.shots.push(shot);
    if (scan.previewId === null) scan.previewId = shot.id;
    enqueue(shot);
  }
  renderShots();
}

function enqueue(shot) {
  shot.status = 'queued';
  if (!scan.pending.includes(shot)) scan.pending.push(shot);
  for (let slot = 0; slot < POOL_SIZE; slot++) {
    if (!scan.busy[slot] && scan.pending.length) runSlot(slot);
  }
}

// Each slot reads one screenshot at a time, until nothing is waiting.
async function runSlot(slot) {
  while (scan.pending.length) {
    const shot = scan.pending.shift();
    if (!scan.shots.includes(shot) && shot !== quick.shot) continue; // removed (or replaced) while queued
    scan.busy[slot] = shot;
    await scanShot(shot).catch(() => {});
    scan.busy[slot] = null;
  }
}

async function scanShot(shot) {
  shot.status = 'scanning';
  shot.progress = 0;
  renderShots();
  const start = performance.now();
  const timings = {};
  let mark = start;
  const lap = (label) => { const now = performance.now(); timings[label] = Math.round(now - mark); mark = now; };
  try {
    shot.img ??= await loadImage(shot.file);
    await ensureNames();
    const ocr = GAME_LANGS[scan.lang].ocr;
    lap('setup');

    // Pass 1: brightness threshold.
    let { canvas, scale } = preprocess(shot.img, Number($('#scanThreshold').value));
    // A quick price check looks for any item, whatever the scanner's "Looking for" is set to.
    const cat = shot.quick ? 'quick' : $('#scanCategory').value;
    const reading1 = readNames(ocr, canvas, scale, cat, NAME_PARAMS, shot);
    // A quick check is often a reward screen with mod cards, which need the white-text pass below. A reward screen
    // is small, so workers are free now: that pass starts straight away, and is used only if it's needed.
    const whiteImage = () => binarize(shot.img, isWhiteText, shot.img.naturalWidth <= 1400 ? 3 : 2);
    let early = null;
    if (shot.quick) {
      const white = whiteImage();
      early = readNames(ocr, white.canvas, white.scale, cat, BLOCK_PARAMS).then((reading) => ({ white, reading }), () => null);
    }
    const first = await reading1;
    let { detections, textH } = first;
    lap('read');

    // Pass 2: keep only the text colour learned from pass 1, which strips most item art. That image is used
    // for everything after this; it's read in full only if pass 1 may have missed names.
    shot.textColor = estimateTextColor(shot.img, first.detections);
    if (shot.textColor) {
      ({ canvas, scale } = preprocessColor(shot.img, shot.textColor));
      if (!looksComplete(first.detections, first.textH)) {
        shot.status = 'refining';
        renderShots();
        const second = await readNames(ocr, withoutSureNames(canvas, scale, first.detections, first.textH), scale, cat, NAME_PARAMS, shot);
        detections = mergeDetections([...second.detections, ...first.detections]);
        textH = second.textH || textH;
        lap('colour');
      }
    }
    // Few clear names so far: maybe white names on mod cards. They're read on their own image and keep it
    // (source) for the re-read below; the inventory passes keep using the cleanest image of theirs.
    if (detections.filter((d) => d.match && !d.match.ambiguous && d.match.score >= 0.9).length < 4) {
      shot.status = 'refining';
      renderShots();
      let { white, reading: third } = (await early) ?? {};
      if (!third) {
        white = whiteImage();
        third = await readNames(ocr, white.canvas, white.scale, cat, BLOCK_PARAMS, shot);
      }
      for (const d of third.detections) d.source = white;
      detections = mergeDetections([...third.detections, ...detections]);
      lap('white');
    }
    shot.processed = canvas;
    detections = await rereadNames(ocr, canvas, scale, detections, textH, cat);
    lap('reread');

    shot.status = 'counting';
    renderShots();
    await readCounts(canvas, scale, detections, textH); // on the cleanest image, so art isn't read as digits
    lap('counts');
    shot.detections = detections;
    shot.status = 'done';
  } catch (err) {
    shot.status = 'error';
    shot.error = err.message;
  }
  shot.seconds = (performance.now() - start) / 1000;
  shot.timings = timings;
  if (shot.quick) { quickDone(shot); return; }
  renderShots();
  aggregate();
}

// ---------- quick price check: one screenshot, the lowest online price of each item on it ----------

const quick = { shot: null, items: [], loading: false, unclear: 0, thumb: null };

function quickCheck(file) {
  if (!file?.type?.startsWith('image/')) return;
  // The screenshot it replaces is let go (a screenshot of a whole screen is a few MB).
  if (quick.shot?.img) URL.revokeObjectURL(quick.shot.img.src);
  if (quick.thumb) URL.revokeObjectURL(quick.thumb);
  quick.thumb = URL.createObjectURL(file);
  quick.shot = { id: scan.nextId++, name: file.name || 'pasted.png', file, time: file.lastModified || Date.now(), img: null, status: 'queued', progress: 0, detections: [], quick: true };
  quick.items = [];
  quick.unclear = 0;
  screenCapture.help = false;
  renderQuick();
  enqueue(quick.shot);
}

async function quickDone(shot) {
  if (shot !== quick.shot) return; // a newer screenshot replaced it
  const byKey = new Map();
  for (const d of shot.detections) {
    if (!d.match || d.match.ambiguous) continue;
    const item = d.match.item;
    const subtype = d.match.subtype ?? (item.subtypes ? item.subtypes[0] : null);
    byKey.set(`${item.slug}|${subtype ?? ''}`, { item, subtype, entry: item.notOnMarket ? null : { slug: item.slug, rank: item.maxRank !== null ? 0 : null, subtype }, price: undefined });
  }
  // Names that fit several items: counted, never guessed. (Other unmatched text is the game's own UI.)
  quick.unclear = shot.detections.filter((d) => d.match?.ambiguous).length;
  quick.items = [...byKey.values()];
  quick.loading = true;
  renderQuick();
  for (const q of quick.items) {
    if (shot !== quick.shot) return;
    if (!q.entry) continue; // not traded on warframe.market: nothing to ask
    await fetchPrice(q.entry);
    q.price = state.prices.get(rowKey(q.entry));
    renderQuick();
  }
  quick.loading = false;
  renderQuick();
}

// The line under the screenshot buttons: the countdown, reading progress, or what came of it, next to a
// thumbnail of the screenshot (so a screenshot of the wrong screen is easy to spot).
function renderQuickStatus() {
  const shot = quick.shot;
  let text = '';
  if (screenCapture.timer) text = t('Screenshot in {n}…', { n: Math.max(1, Math.ceil((screenCapture.at - Date.now()) / 1000)) });
  else if (screenCapture.help) text = t('Click "Take screenshot" first, so your browser can ask which screen to share.');
  else if (shot && BUSY.includes(shot.status)) text = t('Reading the screenshot… {n}%', { n: Math.round(shot.progress * 100) });
  else if (shot?.status === 'error') text = `${t('error')}: ${shot.error}`;
  else if (quick.loading) text = t('Checking prices…');
  else if (shot && !quick.items.length) text = t('No items found on this screenshot.');
  else if (shot) text = t('Screenshot from {time}', { time: new Date(shot.time).toLocaleTimeString(INTL_LOCALE[pageLang]) });
  $('#quickStatus').textContent = text;
  $('#quickShot').hidden = !text;
  const thumb = $('#quickThumb');
  if (quick.thumb && thumb.getAttribute('src') !== quick.thumb) thumb.src = quick.thumb;
  thumb.hidden = !quick.thumb || !!screenCapture.timer || screenCapture.help;
}

function renderQuick() {
  renderQuickStatus();
  const shot = quick.shot;
  const priceOf = (q) => q.price?.lowestSell ?? null;
  const sorted = [...quick.items].sort((a, b) => (priceOf(b) ?? -1) - (priceOf(a) ?? -1) || itemName(a.item).localeCompare(itemName(b.item)));
  fill($('#quickResults'), sorted.map((q) => h('li', null,
    q.item.thumb ? h('img', { src: ASSETS + q.item.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-missing' }),
    h('span', { class: 'quick-name' }, itemName(q.item),
      q.subtype && q.item.tags.includes('relic') && h('span', { class: 'tag' }, t(q.subtype)),
      q.entry?.rank === 0 && h('span', { class: 'tag', title: t("Screenshots don't show mod and arcane ranks: enter them in the Rank column before listing") }, t('rank 0'))),
    h('span', { class: 'quick-values' },
      q.item.notOnMarket ? h('span', { class: 'muted' }, t('not on warframe.market'))
        : q.price === undefined ? h('span', { class: 'muted' }, '…')
        : priceOf(q) === null ? h('span', { class: 'muted' }, q.price?.error ? t('error') : t('none online'))
          : h('b', { class: 'quick-price plat', title: t('Lowest sell') }, `${priceOf(q)}p`),
      q.item.ducats ? h('span', { class: 'quick-ducats ducats', title: t('Ducats') }, t('{n} ducats', { n: q.item.ducats })) : null))));
  $('#quickNote').hidden = !quick.unclear || !shot || shot.status !== 'done';
  $('#quickNote').textContent = t("{n} names couldn't be read for sure, so they're left out.", { n: quick.unclear });
}

// ---------- screenshot shortcut: the game's screen, straight into the quick price check ----------

// A screen is shared with this page once: browsers ask which one, and only after a click. From then on the
// shortcut (passed on by the background script) or the button waits the delay, so you can switch to the game,
// then takes the screen as it is and checks it. The picture stays in this page. Sharing ends with "Stop
// sharing", here or in the browser's own bar, or when the page closes.
const screenCapture = { stream: null, video: null, timer: null, ticker: null, at: 0, help: false, sound: null, shortcut: '' };
const CAPTURE_DELAYS = [0, 1, 2, 3, 5]; // seconds
const IS_FIREFOX = typeof browser.runtime.getBrowserInfo === 'function'; // its shortcuts only work while it's in front
const screenShared = () => !!screenCapture.stream;

async function shareScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor', frameRate: { ideal: 2, max: 5 } }, // stills are all that's needed
    audio: false,
    selfBrowserSurface: 'exclude', // Chrome / Edge: don't offer this tab
  });
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    throw err;
  }
  stream.getVideoTracks()[0].addEventListener('ended', stopSharing); // stopped from the browser's own bar
  warmUp();
  screenCapture.stream = stream;
  screenCapture.video = video;
  screenCapture.help = false;
}

function stopSharing() {
  clearCountdown();
  screenCapture.stream?.getTracks().forEach((track) => track.stop());
  if (screenCapture.video) screenCapture.video.srcObject = null;
  screenCapture.stream = screenCapture.video = null;
  screenCapture.sound?.close().catch(() => {});
  screenCapture.sound = null;
  renderCapture();
}

async function onCaptureClick() {
  // The click sound needs a click to be allowed; made here, it can play when the screenshot is taken.
  try { screenCapture.sound ??= new AudioContext(); } catch { /* no sound then */ }
  if (screenCapture.sound?.state === 'suspended') screenCapture.sound.resume().catch(() => {});
  if (!screenShared()) {
    try {
      await shareScreen();
    } catch (err) {
      stopSharing();
      setStatus(err.name === 'NotAllowedError' ? t("The screen wasn't shared.") : `${t("The screen wasn't shared.")} (${err.message})`);
      return;
    }
  }
  captureSoon();
}

// The shortcut or the button: count down, then take the screenshot. Without a shared screen, says what to do.
function captureSoon() {
  showTab('quick');
  if (!screenShared()) {
    screenCapture.help = true;
    renderCapture();
    return;
  }
  if (screenCapture.timer) return; // already counting down
  const delay = Number($('#captureDelay').value) * 1000;
  screenCapture.at = Date.now() + delay;
  screenCapture.timer = setTimeout(takeScreenshot, delay);
  screenCapture.ticker = setInterval(renderQuickStatus, 250);
  renderCapture();
}

function clearCountdown() {
  clearTimeout(screenCapture.timer);
  clearInterval(screenCapture.ticker);
  screenCapture.timer = screenCapture.ticker = null;
}

async function takeScreenshot() {
  clearCountdown();
  const { video } = screenCapture;
  if (!video?.videoWidth) { renderCapture(); return; }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const takenAt = Date.now();
  shutterSound();
  renderCapture();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  quickCheck(new File([blob], 'screenshot.png', { type: 'image/png', lastModified: takenAt }));
}

// A short, soft click when the screenshot is taken: by then you're probably looking at the game.
function shutterSound() {
  const ctx = screenCapture.sound;
  if (ctx?.state !== 'running') return;
  const now = ctx.currentTime;
  const tone = ctx.createOscillator();
  const gain = ctx.createGain();
  tone.type = 'triangle';
  tone.frequency.setValueAtTime(1400, now);
  tone.frequency.exponentialRampToValueAtTime(600, now + 0.08);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  tone.connect(gain).connect(ctx.destination);
  tone.start(now);
  tone.stop(now + 0.13);
}

// The shortcut as set in the browser (people can change it there).
async function loadShortcut() {
  try {
    screenCapture.shortcut = (await browser.commands.getAll()).find((c) => c.name === 'quick-capture')?.shortcut ?? '';
  } catch {
    screenCapture.shortcut = '';
  }
  renderCapture();
}

function openShortcutSettings() {
  if (typeof browser.commands.openShortcutSettings === 'function') return browser.commands.openShortcutSettings();
  return browser.tabs.create({ url: `${/\bEdg\//.test(navigator.userAgent) ? 'edge' : 'chrome'}://extensions/shortcuts` });
}

function renderCapture() {
  const sharing = screenShared();
  $('#captureBtn').disabled = !!screenCapture.timer;
  $('#captureStop').hidden = !sharing;
  const seconds = new Intl.NumberFormat(INTL_LOCALE[pageLang], { style: 'unit', unit: 'second', unitDisplay: 'short' });
  for (const option of $('#captureDelay').options) option.textContent = seconds.format(Number(option.value));
  const keys = screenCapture.shortcut ? screenCapture.shortcut.split('+') : [];
  const canChange = typeof browser.commands.openShortcutSettings === 'function' || !IS_FIREFOX;
  fill($('#captureKey'), t('Shortcut:'), ' ',
    keys.length ? keys.map((k, i) => [i ? '+' : '', h('kbd', null, k)]) : t('not set'),
    ' · ', IS_FIREFOX ? t('works while the browser is in front') : t('works in the game too'),
    canChange && [' · ', h('a', { href: '#', 'data-action': 'change-shortcut' }, t('change'))]);
  $('#captureHint').textContent = sharing
    ? t('Sharing your screen with this page. Screenshots never leave this computer.')
    : t('The first time, your browser asks which screen to share: pick the one the game is on.');
  renderQuickStatus();
}

function wireCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia) { $('#captureBar').hidden = $('#captureHint').hidden = true; return; }
  const delay = $('#captureDelay');
  delay.append(...CAPTURE_DELAYS.map((s) => h('option', { value: s })));
  delay.value = storageGet('captureDelay', '2');
  if (!delay.value) delay.value = '2';
  delay.addEventListener('change', () => storageSet('captureDelay', delay.value));
  $('#captureBtn').addEventListener('click', onCaptureClick);
  $('#captureStop').addEventListener('click', stopSharing);
  $('#captureKey').addEventListener('click', (ev) => {
    if (ev.target.dataset.action !== 'change-shortcut') return;
    ev.preventDefault();
    openShortcutSettings();
  });
  window.addEventListener('focus', loadShortcut); // it may have been changed in the browser's settings meanwhile
  renderCapture();
  loadShortcut();
  // Opened by the shortcut, with no app tab open yet
  if (location.hash === '#capture') {
    history.replaceState(null, '', location.pathname + location.search);
    captureSoon();
  }
}

// A whole prepared screenshot is read in horizontal bands, one per worker, side by side. Bands overlap by more
// than a line of text, and each word is kept from the band whose own part holds its centre: there it's whole.
const BAND_MIN = 400; // canvas pixels; smaller images are read in one piece
async function readInBands(ocr, canvas, params, shot) {
  const n = Math.max(1, Math.min(OCR_WORKERS, Math.floor(canvas.height / BAND_MIN)));
  const overlap = Math.round(Math.max(120, canvas.height * 0.04));
  const progress = new Array(n).fill(0);
  const bands = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const own0 = Math.round((canvas.height * i) / n), own1 = Math.round((canvas.height * (i + 1)) / n);
    const y0 = n === 1 ? 0 : Math.max(0, own0 - overlap), y1 = n === 1 ? canvas.height : Math.min(canvas.height, own1 + overlap);
    let image = canvas;
    if (n > 1) {
      image = document.createElement('canvas');
      image.width = canvas.width;
      image.height = y1 - y0;
      image.getContext('2d').drawImage(canvas, 0, y0, canvas.width, y1 - y0, 0, 0, canvas.width, y1 - y0);
    }
    const data = await ocrJob(ocr, image, params, { blocks: true }, (p) => {
      progress[i] = p;
      if (shot) { shot.progress = progress.reduce((a, b) => a + b, 0) / n; renderShotsSoon(); }
    });
    return wordsFrom(data)
      .map((w) => ({ text: w.text, confidence: w.confidence, bbox: { x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0 + y0, y1: w.bbox.y1 + y0 } }))
      .filter((w) => { const cy = (w.bbox.y0 + w.bbox.y1) / 2; return cy >= own0 && cy < own1; });
  }));
  return bands.flat();
}

async function readNames(ocr, canvas, scale, cat, params = NAME_PARAMS, shot = null) {
  const { detections, textH } = analyze(await readInBands(ocr, canvas, params, shot), scale);
  detections.forEach((d) => matchDetection(d, cat));
  return { detections, textH };
}

// Detections from several passes describe the same tiles; where boxes overlap, keep the better match. Between
// two readings that match nothing, keep the one with more text: a piece of a name ("Bronco Prime") rather than
// a bit of item art read as letters, which it can still be completed from.
function mergeDetections(all) {
  const kept = [];
  const order = (a, b) => matchQuality(b.match) - matchQuality(a.match) || textWeight(b.segs.join('')) - textWeight(a.segs.join(''));
  for (const d of [...all].sort(order)) {
    if (!kept.some((k) => boxesOverlap(k, d))) kept.push(d);
  }
  return kept;
}

// ---------- merging screenshots ----------

const detectionKey = (d) => (d.match ? `item:${d.match.item.slug}|${d.match.subtype ?? ''}` : 'raw:' + d.norm);

function aggregate() {
  const groups = new Map();
  for (const shot of scan.shots) {
    for (const d of shot.detections) {
      if (!d.match && textWeight(d.norm, true) < 6) continue; // short junk text
      const key = detectionKey(d);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, item: d.match?.item ?? null, subtype: d.match?.subtype ?? null, score: 0, ambiguous: true, perShot: new Map(), texts: new Set() }));
      const seen = g.perShot.get(shot.id) ?? { shot, qty: 0, counted: false };
      seen.qty += d.qty;
      seen.counted ||= !!d.countBox; // a count was read on the tile (no number on a tile means 1, or cut off)
      g.perShot.set(shot.id, seen);
      g.score = Math.max(g.score, d.match?.score ?? 0);
      if (d.match && !d.match.ambiguous) g.ambiguous = false; // one clear reading is enough
      g.texts.add(d.text);
    }
  }
  scan.rows = [...groups.values()].map((g) => {
    const edit = scan.edits.get(g.key) || {};
    const seen = [...g.perShot.values()].sort((a, b) => a.shot.time - b.shot.time || a.shot.id - b.shot.id);
    const counted = seen.filter((x) => x.counted);
    const latest = counted.length ? counted[counted.length - 1] : seen[seen.length - 1];
    const item = edit.slug !== undefined ? state.bySlug.get(edit.slug) ?? null : g.item;
    const subtype = edit.subtype ?? g.subtype;
    return {
      key: g.key,
      item,
      subtype: item?.subtypes?.includes(subtype) ? subtype : item?.subtypes?.[0] ?? null,
      qty: edit.qty ?? latest.qty,
      // false: no count was visible anywhere, so an item already in your list keeps its quantity
      qtySeen: edit.qty !== undefined || counted.length > 0,
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

const BUSY = ['queued', 'scanning', 'refining', 'counting'];

function renderShots() {
  fill($('#shots'), scan.shots.map((s, i) => {
    let status = t('waiting');
    if (s.status === 'scanning') status = t('reading {n}%', { n: Math.round(s.progress * 100) });
    if (s.status === 'refining') status = t('reading again…');
    if (s.status === 'counting') status = t('reading counts…');
    if (s.status === 'done') status = t('{n} items', { n: s.detections.filter((d) => d.match).length });
    if (s.status === 'error') status = t('error');
    const title = s.error || (s.seconds && s.status === 'done' ? t('{name} · read in {s} s', { name: s.name, s: s.seconds.toFixed(1) }) : s.name);
    return h('div', { class: `shot${s.id === scan.previewId ? ' active' : ''}`, 'data-id': s.id, title },
      h('span', { class: 'shot-n' }, `#${i + 1}`),
      h('span', { class: `shot-status ${s.status}` }, status),
      h('button', { class: 'icon', 'data-action': 'remove-shot', title: t('Remove screenshot') }, '✕'));
  }));
  $('#scanResults').hidden = scan.shots.length === 0;
  const busy = scan.shots.some((s) => BUSY.includes(s.status));
  $('#scanStatus').textContent = busy
    ? (pools.size ? t('Reading screenshots…') : t('Loading text recognition (first time takes a few seconds)…'))
    : '';
}

let shotsQueued = false;
function renderShotsSoon() {
  if (shotsQueued) return;
  shotsQueued = true;
  requestAnimationFrame(() => { shotsQueued = false; renderShots(); if (quick.shot) renderQuickStatus(); });
}

function renderScanRows() {
  const showUnknown = $('#scanShowUnknown').checked;
  const rows = scan.rows.filter((r) => r.item || showUnknown);
  const unknown = scan.rows.filter((r) => !r.item).length;
  fill($('#scanTable tbody'), rows.map((r) => {
    const conf = r.item ? Math.round(r.score * 100) : 0;
    const confCls = !r.item || r.ambiguous ? 'bad' : r.score >= 0.85 ? 'good' : r.score >= 0.75 ? 'plat' : 'bad';
    return h('tr', { 'data-key': r.key },
      h('td', null, h('input', { type: 'checkbox', 'data-field': 'checked', checked: r.checked })),
      h('td', null, h('div', { class: 'scan-item-wrap' },
        h('input', { class: 'scan-item', list: 'itemNames', 'data-field': 'slug', value: r.ambiguous || !r.item ? '' : itemName(r.item),
          placeholder: r.ambiguous ? t('Which item is this?') : t('Pick the right item…') }),
        r.item?.subtypes && !r.ambiguous && h('select', { class: 'scan-subtype', 'data-field': 'subtype', title: t('Refinement') },
          r.item.subtypes.map((s) => h('option', { value: s, selected: s === r.subtype }, t(s)))))),
      h('td', { class: 'r' }, h('input', { class: r.qtySeen ? 'num' : 'num qty-unseen', type: 'number', min: 1, 'data-field': 'qty', value: r.qty,
        title: r.qtySeen ? null : t('No count visible: an item already in your list keeps its quantity (type a number to set it)') })),
      h('td', { class: 'muted' }, r.shots.map(shotLabel).join(' ')),
      h('td', { class: 'muted ocr', title: r.text }, r.text),
      h('td', { class: `r ${confCls}`, title: r.ambiguous ? t('Only part of the name was readable and it fits several items') : null },
        r.ambiguous ? t('unclear') : r.item ? `${conf}%` : '—'));
  }));
  const checked = scan.rows.filter((r) => r.checked && r.item && !r.ambiguous);
  const unclear = scan.rows.filter((r) => r.ambiguous).length;
  $('#scanSummary').textContent = [
    t('{n} matched', { n: scan.rows.length - unknown - unclear }),
    t('{n} selected', { n: checked.length }),
    unclear ? t('{n} unclear (pick the item)', { n: unclear }) : '',
    unknown ? t('{n} unrecognised texts', { n: unknown }) : '',
  ].filter(Boolean).join(', ');
  $('#scanAdd').disabled = checked.length === 0;
}

function renderPreview() {
  const shot = scan.shots.find((s) => s.id === scan.previewId);
  const canvas = $('#scanPreview');
  if (!shot || !shot.img) { canvas.hidden = true; return; }
  canvas.hidden = false;
  const src = $('#scanProcessed').checked && shot.processed ? shot.processed : shot.img;
  const w = shot.img.naturalWidth, imgH = shot.img.naturalHeight;
  canvas.width = w;
  canvas.height = imgH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, w, imgH);
  const lw = Math.max(2, w / 800);
  ctx.lineWidth = lw;
  ctx.font = `${Math.max(12, w / 110)}px system-ui, sans-serif`;
  for (const d of shot.detections) {
    const row = scan.rows.find((r) => r.key === detectionKey(d));
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
      const label = `${itemName(item)}${row.subtype && row.subtype !== item.subtypes[0] ? ` (${t(row.subtype)})` : ''} ×${d.qty}`;
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
  const byKey = new Map();
  for (const r of scan.rows) {
    if (!r.checked || !r.item || r.ambiguous) continue;
    // Two rows resolving to one item are most likely the same tile misread differently: keep the max,
    // preferring a count that was actually seen.
    const key = `${r.item.slug}|${r.subtype ?? ''}`;
    const prev = byKey.get(key);
    const qty = prev && prev.qtyKnown !== r.qtySeen ? (r.qtySeen ? r.qty : prev.qty) : Math.max(prev?.qty ?? 0, r.qty);
    byKey.set(key, { slug: r.item.slug, subtype: r.subtype, qty, qtyKnown: r.qtySeen || !!prev?.qtyKnown });
  }
  const entries = [...byKey.values()].map((e) => ({ ...e, rank: null }));
  const setQty = $('#scanMode').value === 'set';
  addEntries(entries, { setQty });
  setStatus((setQty ? t('Updated {n} items from screenshots.', { n: entries.length }) : t('Added {n} items from screenshots.', { n: entries.length }))
    + (setQty && entries.some((e) => !e.qtyKnown) ? ' ' + t('Items without a visible count kept the quantity they had.') : ''));
}

// Called by the page when its language changes.
function renderScanTexts() {
  renderQuick();
  renderCapture();
  renderShots();
  renderScanRows();
  renderPreview();
}

// ---------- events ----------

function wireScan() {
  const drop = $('#dropZone');
  drop.addEventListener('click', () => $('#scanFiles').click());
  $('#scanFiles').addEventListener('change', (ev) => { addShots([...ev.target.files]); ev.target.value = ''; });
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  document.addEventListener('dragenter', warmUp); // a screenshot is on its way
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
    if (activeTab() === 'quick') { quickCheck(files[0]); return; }
    addShots(files);
    $('#scanCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Quick price check: drop, click to choose, or paste (above).
  const quickDrop = $('#quickDrop');
  quickDrop.addEventListener('click', () => $('#quickFile').click());
  $('#quickFile').addEventListener('change', (ev) => { quickCheck(ev.target.files[0]); ev.target.value = ''; });
  quickDrop.addEventListener('dragover', (ev) => { ev.preventDefault(); quickDrop.classList.add('over'); });
  quickDrop.addEventListener('dragleave', () => quickDrop.classList.remove('over'));
  quickDrop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    quickDrop.classList.remove('over');
    quickCheck([...ev.dataTransfer.files].find((f) => f.type.startsWith('image/')));
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

  // Game language: remembered, and screenshots already added are read again in the new language.
  const langSelect = $('#scanLang');
  langSelect.append(...Object.entries(GAME_LANGS).map(([code, l]) => h('option', { value: code }, l.label)));
  setLanguage(storageGet('scanLang', guessLanguage()));
  langSelect.value = scan.lang;
  flagPicker(langSelect);
  // The quick price check has its own picker for the same setting.
  const quickLang = $('#quickLang');
  quickLang.append(...Object.entries(GAME_LANGS).map(([code, l]) => h('option', { value: code }, l.label)));
  quickLang.value = scan.lang;
  flagPicker(quickLang);
  quickLang.addEventListener('change', () => {
    if (langSelect.value === quickLang.value) return;
    langSelect.value = quickLang.value;
    langSelect.dispatchEvent(new Event('change'));
  });
  langSelect.addEventListener('change', () => {
    setLanguage(langSelect.value);
    storageSet('scanLang', scan.lang);
    quickLang.value = scan.lang;
    quickLang.syncPicker();
    scan.shots.forEach(enqueue);
    if (quick.shot) { quick.items = []; enqueue(quick.shot); renderQuick(); }
    renderShots();
  });

  $('#scanThreshold').addEventListener('input', () => { $('#scanThresholdVal').textContent = $('#scanThreshold').value; });
  $('#scanRescan').addEventListener('click', () => { scan.shots.forEach(enqueue); renderShots(); });
  $('#scanCategory').addEventListener('change', () => {
    for (const s of scan.shots) s.detections.forEach((d) => matchDetection(d));
    aggregate();
  });
  $('#scanProcessed').addEventListener('change', renderPreview);
  $('#scanPreview').addEventListener('click', () => $('.scan-grid').classList.toggle('big-preview'));
  $('#scanShowUnknown').addEventListener('change', renderScanRows);
  $('#scanClear').addEventListener('click', () => {
    scan.shots = [];
    scan.pending = [];
    scan.rows = [];
    scan.edits.clear();
    scan.previewId = null;
    renderShots();
    renderScanRows();
    renderPreview();
  });
  $('#scanAdd').addEventListener('click', addScanToList);
  wireCapture();

  $('#scanTable tbody').addEventListener('change', (ev) => {
    const field = ev.target.dataset.field;
    const key = ev.target.closest('tr')?.dataset.key;
    if (!field || !key) return;
    const edit = scan.edits.get(key) || {};
    if (field === 'checked') edit.checked = ev.target.checked;
    if (field === 'qty') edit.qty = Math.max(1, Number(ev.target.value) || 1);
    if (field === 'subtype') edit.subtype = ev.target.value;
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
