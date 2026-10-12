'use strict';
/* global browser, Tesseract, Backend, state, category, findItem, addEntries, setStatus, h, fill, $, storageGet, storageSet */
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

// Two screenshots are read at the same time on computers with enough cores.
const POOL_SIZE = Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

const scan = {
  shots: [],         // { id, name, img, status, progress, detections, processed, seconds, timings }
  nextId: 1,
  pending: [],       // shots waiting for a free worker
  workers: [],       // per slot: { ocr, promise }
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

// Stack counts are digits in every language, and the English model reads them best (the Ukrainian one takes
// a 3 for a З). One worker serves both slots: its settings never change, and its jobs are short.
let countWorker = null;
function getCountWorker() {
  countWorker ??= createWorker('eng').then(async (w) => { await w.setParameters(COUNT_PARAMS); return w; });
  countWorker.catch(() => { countWorker = null; });
  return countWorker;
}

// Each slot has its own worker, created for the current game language (and replaced when it changes).
async function getWorker(slot) {
  const ocr = GAME_LANGS[scan.lang].ocr;
  const current = scan.workers[slot];
  if (current?.ocr === ocr) return current.promise;
  if (current) current.promise.then((w) => w.terminate()).catch(() => {});
  const promise = createWorker(ocr, (m) => {
    const shot = scan.busy[slot];
    if (shot && m.status === 'recognizing text') {
      shot.progress = m.progress;
      renderShotsSoon();
    }
  });
  scan.workers[slot] = { ocr, promise };
  promise.catch(() => { if (scan.workers[slot]?.promise === promise) scan.workers[slot] = null; });
  return promise;
}

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
    throw new Error(`Could not load ${GAME_LANGS[scan.lang].label} item names: ${err.message}`);
  }
}

// The browser's language is the best first guess for the game's.
function guessLanguage() {
  const l = (navigator.language || 'en').toLowerCase();
  if (l.startsWith('uk')) return 'uk';
  if (l.startsWith('es')) return 'es';
  if (/^zh-(tw|hk|mo|hant)/.test(l)) return 'zh-hant';
  if (l.startsWith('zh')) return 'zh-hans';
  return 'en';
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
// coordinates. r is in screenshot pixels; the canvas is the upscaled, black-on-white one.
const CROP_MARGIN = 8;
async function recognizeArea(worker, canvas, scale, r, output) {
  const w = Math.max(1, Math.round((r.x1 - r.x0) * scale)), ht = Math.max(1, Math.round((r.y1 - r.y0) * scale));
  const c = document.createElement('canvas');
  c.width = w + 2 * CROP_MARGIN;
  c.height = ht + 2 * CROP_MARGIN;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, Math.round(r.x0 * scale), Math.round(r.y0 * scale), w, ht, CROP_MARGIN, CROP_MARGIN, w, ht);
  const { data } = await worker.recognize(c, {}, output);
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

  const worker = await getCountWorker();
  for (const row of rows) {
    // Every tile in a row ends at the same height, just under its lowest name line.
    const rowBottom = Math.max(...row.map((d) => d.y1));
    for (const d of row) {
      if (d.countBox) continue; // already found next to the name
      const left = Math.max(0, cx(d) - W / 2), right = Math.min(imgW, cx(d) + W / 2);
      const tileTop = Math.max(0, rowBottom - H + textH);
      const top = tileTop, bottom = Math.min(d.y0 - textH * 0.2, tileTop + (d.y0 - tileTop) * 0.4);
      if (bottom - top < textH || right - left < textH) continue;
      const { words } = await recognizeArea(worker, canvas, scale, { x0: left, y0: top, x1: right, y1: bottom }, { blocks: true });
      const nums = words
        .filter((w) => w.confidence >= 80 && COUNT_RE.test(w.text.trim()))
        .filter((w) => { const wh = w.box.y1 - w.box.y0; return wh >= textH * 0.6 && wh <= textH * 1.8; })
        .sort((a, b) => a.box.y0 - b.box.y0);
      if (!nums.length) continue;
      const qty = Number(nums[0].text.replace(/[^0-9]/g, ''));
      if (qty > 1) {
        d.qty = qty;
        d.countText = `${nums[0].text} (${Math.round(nums[0].confidence)}%)`;
        d.countBox = nums[0].box;
      }
    }
  }
}

// ---------- matching text to items ----------

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
  const key = `${cat}|${scan.lang}|${!!scan.names}`;
  if (indexCache.key === key) return indexCache.list;
  const list = [];
  for (const item of state.items) {
    if (item.tags.includes('set')) continue; // sets aren't inventory items
    if (cat && category(item) !== cat) continue;
    // The inventory shows the same full names as warframe.market ("... Systems Blueprint"), so no
    // shortened variants: "Epitaph Prime" alone must stay unclear, not become "Epitaph Prime Blueprint".
    list.push({ norm: norm(scan.names?.[item.slug] ?? item.name), item });
  }
  indexCache = { key, list };
  return list;
}

function bestMatch(text) {
  const q = norm(text);
  if (textWeight(q, true) < 4) return null;
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
  // The same goes when the reading without its first or last character does: that character may be all
  // that's left of the distinctive part ("5 Prime 刀刃" when 翁 or 关刀 was lost, as many names end "Prime 刀刃").
  const fitsSeveral = (part) => {
    const containing = new Set();
    for (const v of matchIndex()) if (v.norm !== q && v.norm.includes(part)) containing.add(v.item);
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
function matchDetection(d) {
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
      const m = t.length ? bestMatch(t.join(' ')) : null;
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
// and keeps that reading when it matches better.
async function rereadNames(worker, canvas, scale, detections, textH) {
  await worker.setParameters(TILE_PARAMS);
  const imgW = canvas.width / scale, imgH = canvas.height / scale;
  for (const d of detections) {
    if (!d.match && textWeight(d.segs.join('')) < 5) continue; // stray letters, not a name
    const padX = (d.x1 - d.x0) * 0.15;
    const r = { x0: Math.max(0, d.x0 - padX), y0: Math.max(0, d.y0 - textH * 1.3), x1: Math.min(imgW, d.x1 + padX), y1: Math.min(imgH, d.y1 + textH * 1.3) };
    d.area = r;
    // An exact, clear match can't be improved on, so it isn't read again (relics are, for a refinement line).
    if (matchQuality(d.match) >= 1 && !d.match.item.subtypes) continue;
    const { text } = await recognizeArea(worker, canvas, scale, r);
    const reread = { segs: text.split('\n').map((s) => s.trim()).filter(Boolean) };
    matchDetection(reread);
    if (isBetter(reread.match, d.match)) {
      Object.assign(d, { segs: reread.segs, text: reread.text, norm: reread.norm, match: reread.match });
    }
  }
  // A name whose middle wasn't read falls apart into two pieces side by side. Two unclear pieces on one line
  // are read again together, and replaced by that reading only if it's a clear match.
  const weak = (d) => (!d.match || d.match.ambiguous) && textWeight(d.segs.join('')) >= 3;
  for (const a of [...detections]) {
    for (const b of [...detections]) {
      if (a === b || a.joined || b.joined || !weak(a) || !weak(b)) continue;
      const gap = b.x0 - a.x1;
      if (gap <= 0 || gap > textH * 4 || Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) > textH) continue;
      const u = box([a, b]);
      const r = { x0: Math.max(0, u.x0 - textH), y0: Math.max(0, u.y0 - textH * 1.3), x1: Math.min(imgW, u.x1 + textH), y1: Math.min(imgH, u.y1 + textH * 1.3) };
      const { text } = await recognizeArea(worker, canvas, scale, r);
      const joined = { ...u, segs: text.split('\n').map((s) => s.trim()).filter(Boolean), qty: 1, countBox: null, area: r };
      matchDetection(joined);
      if (joined.match && !joined.match.ambiguous && joined.match.score >= 0.8) {
        a.joined = b.joined = true;
        detections.push(joined);
      }
    }
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
    const shot = { id: scan.nextId++, name: file.name || `pasted-${scan.nextId}.png`, file, img: null, status: 'queued', progress: 0, detections: [] };
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

// Each slot reads one screenshot at a time with its own worker, until nothing is waiting.
async function runSlot(slot) {
  while (scan.pending.length) {
    const shot = scan.pending.shift();
    if (!scan.shots.includes(shot)) continue; // removed while queued
    scan.busy[slot] = shot;
    await scanShot(shot, slot).catch(() => {});
    scan.busy[slot] = null;
  }
}

async function scanShot(shot, slot) {
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
    const worker = await getWorker(slot);
    lap('setup');

    // Pass 1: brightness threshold.
    let { canvas, scale } = preprocess(shot.img, Number($('#scanThreshold').value));
    const first = await readNames(worker, canvas, scale);
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
        const second = await readNames(worker, canvas, scale);
        detections = mergeDetections([...second.detections, ...first.detections]);
        textH = second.textH || textH;
        lap('colour');
      }
    }
    shot.processed = canvas;
    detections = await rereadNames(worker, canvas, scale, detections, textH);
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
  renderShots();
  aggregate();
}

async function readNames(worker, canvas, scale) {
  await worker.setParameters(NAME_PARAMS);
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const { detections, textH } = analyze(wordsFrom(data), scale);
  detections.forEach(matchDetection);
  return { detections, textH };
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

const detectionKey = (d) => (d.match ? `item:${d.match.item.slug}|${d.match.subtype ?? ''}` : 'raw:' + d.norm);

function aggregate() {
  const groups = new Map();
  for (const shot of scan.shots) {
    for (const d of shot.detections) {
      if (!d.match && textWeight(d.norm, true) < 6) continue; // short junk text
      const key = detectionKey(d);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, item: d.match?.item ?? null, subtype: d.match?.subtype ?? null, score: 0, ambiguous: true, perShot: new Map(), texts: new Set() }));
      g.perShot.set(shot.id, (g.perShot.get(shot.id) || 0) + d.qty);
      g.score = Math.max(g.score, d.match?.score ?? 0);
      if (d.match && !d.match.ambiguous) g.ambiguous = false; // one clear reading is enough
      g.texts.add(d.text);
    }
  }
  scan.rows = [...groups.values()].map((g) => {
    const edit = scan.edits.get(g.key) || {};
    const item = edit.slug !== undefined ? state.bySlug.get(edit.slug) ?? null : g.item;
    const subtype = edit.subtype ?? g.subtype;
    return {
      key: g.key,
      item,
      subtype: item?.subtypes?.includes(subtype) ? subtype : item?.subtypes?.[0] ?? null,
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

const BUSY = ['queued', 'scanning', 'refining', 'counting'];

function renderShots() {
  fill($('#shots'), scan.shots.map((s, i) => {
    let status = s.status;
    if (s.status === 'scanning') status = `reading ${Math.round(s.progress * 100)}%`;
    if (s.status === 'refining') status = 'reading again…';
    if (s.status === 'counting') status = 'reading counts…';
    if (s.status === 'done') status = `${s.detections.filter((d) => d.match).length} items`;
    if (s.status === 'error') status = 'error';
    const title = s.error || (s.seconds && s.status === 'done' ? `${s.name} · read in ${s.seconds.toFixed(1)} s` : s.name);
    return h('div', { class: `shot${s.id === scan.previewId ? ' active' : ''}`, 'data-id': s.id, title },
      h('span', { class: 'shot-n' }, `#${i + 1}`),
      h('span', { class: `shot-status ${s.status}` }, status),
      h('button', { class: 'icon', 'data-action': 'remove-shot', title: 'Remove screenshot' }, '✕'));
  }));
  $('#scanEmpty').hidden = scan.shots.length > 0;
  $('#scanResults').hidden = scan.shots.length === 0;
  const busy = scan.shots.some((s) => BUSY.includes(s.status));
  $('#scanStatus').textContent = busy
    ? (scan.workers.some(Boolean) ? 'Reading screenshots…' : 'Loading text recognition (first time takes a few seconds)…')
    : '';
}

let shotsQueued = false;
function renderShotsSoon() {
  if (shotsQueued) return;
  shotsQueued = true;
  requestAnimationFrame(() => { shotsQueued = false; renderShots(); });
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
        h('input', { class: 'scan-item', list: 'itemNames', 'data-field': 'slug', value: r.ambiguous ? '' : r.item?.name ?? '',
          placeholder: r.ambiguous ? 'Which item is this?' : 'Pick the right item…' }),
        r.item?.subtypes && !r.ambiguous && h('select', { class: 'scan-subtype', 'data-field': 'subtype', title: 'Refinement' },
          r.item.subtypes.map((s) => h('option', { selected: s === r.subtype }, s))))),
      h('td', { class: 'r' }, h('input', { class: 'num', type: 'number', min: 1, 'data-field': 'qty', value: r.qty })),
      h('td', { class: 'muted' }, r.shots.map(shotLabel).join(' ')),
      h('td', { class: 'muted ocr', title: r.text }, r.text),
      h('td', { class: `r ${confCls}`, title: r.ambiguous ? 'Only part of the name was readable and it fits several items' : null },
        r.ambiguous ? 'unclear' : r.item ? `${conf}%` : '—'));
  }));
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
      const label = `${item.name}${row.subtype && row.subtype !== item.subtypes[0] ? ` (${row.subtype})` : ''} ×${d.qty}`;
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
    // Two rows resolving to one item are most likely the same tile misread differently: keep the max.
    const key = `${r.item.slug}|${r.subtype ?? ''}`;
    const prev = byKey.get(key);
    byKey.set(key, { slug: r.item.slug, subtype: r.subtype, qty: Math.max(prev?.qty ?? 0, r.qty) });
  }
  const entries = [...byKey.values()].map((e) => ({ ...e, rank: null }));
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

  // Game language: remembered, and screenshots already added are read again in the new language.
  const langSelect = $('#scanLang');
  langSelect.append(...Object.entries(GAME_LANGS).map(([code, l]) => h('option', { value: code }, l.label)));
  setLanguage(storageGet('scanLang', guessLanguage()));
  langSelect.value = scan.lang;
  langSelect.addEventListener('change', () => {
    setLanguage(langSelect.value);
    storageSet('scanLang', scan.lang);
    scan.shots.forEach(enqueue);
    renderShots();
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
    scan.pending = [];
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
