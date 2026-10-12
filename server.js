// Warframe Help — local price checker for warframe.market
// Zero-dependency Node server: proxies the warframe.market API (which has no CORS),
// throttles to their 3 req/s limit, caches results, and stores your inventory on disk.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const PUBLIC_DIR = path.join(ROOT, 'public');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const config = {
  username: 'emperortrump',
  platform: 'pc',
  port: 3000,
  priceTtlMinutes: 30,
  ...readJson(path.join(ROOT, 'config.json'), {}),
};

const API = 'https://api.warframe.market';
const ITEMS_TTL = 24 * 60 * 60 * 1000;
const PRICE_TTL = config.priceTtlMinutes * 60 * 1000;
const ORDERS_TTL = 60 * 1000;

// ---------- small helpers ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- upstream access (throttled) ----------

let queue = Promise.resolve();
let lastRequest = 0;
const MIN_GAP_MS = 350; // stays under warframe.market's 3 requests/second

function wfm(pathAndQuery) {
  const run = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = lastRequest + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequest = Date.now();
      const res = await fetch(API + pathAndQuery, {
        headers: {
          'Language': 'en',
          'Platform': config.platform,
          'Crossplay': 'true',
          'Accept': 'application/json',
          'User-Agent': 'WarframeHelp/1.0 (personal price checker)',
        },
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(`warframe.market ${res.status} for ${pathAndQuery}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body.data;
    }
    throw new Error(`warframe.market kept rate-limiting ${pathAndQuery}`);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// ---------- items ----------

const ITEMS_FILE = path.join(CACHE_DIR, 'items.json');
let itemsCache = readJson(ITEMS_FILE, null);
let itemsByGameRef = null;

async function getItems(force = false) {
  if (!force && itemsCache && Date.now() - itemsCache.fetchedAt < ITEMS_TTL) return itemsCache.items;
  const raw = await wfm('/v2/items');
  const items = raw.map((i) => ({
    id: i.id,
    slug: i.slug,
    name: i.i18n?.en?.name ?? i.slug,
    thumb: i.i18n?.en?.thumb ?? null,
    tags: i.tags ?? [],
    gameRef: i.gameRef ?? null,
    maxRank: i.maxRank ?? null,
    ducats: i.ducats ?? null,
    subtypes: i.subtypes ?? null,
    vaulted: i.vaulted ?? false,
  }));
  itemsCache = { fetchedAt: Date.now(), items };
  itemsByGameRef = null;
  writeJson(ITEMS_FILE, itemsCache);
  return items;
}

async function gameRefIndex() {
  if (!itemsByGameRef) {
    itemsByGameRef = new Map();
    for (const it of await getItems()) if (it.gameRef) itemsByGameRef.set(it.gameRef, it);
  }
  return itemsByGameRef;
}

// ---------- prices ----------

const PRICES_FILE = path.join(CACHE_DIR, 'prices.json');
const prices = readJson(PRICES_FILE, {});
let pricesDirty = false;
setInterval(() => {
  if (pricesDirty) { writeJson(PRICES_FILE, prices); pricesDirty = false; }
}, 5000).unref();

async function getPrice(slug, rank, subtype, force) {
  const params = new URLSearchParams();
  if (rank !== null && rank !== undefined && rank !== '') params.set('rank', rank);
  if (subtype) params.set('subtype', subtype);
  const qs = params.toString();
  const key = `${slug}?${qs}`;
  const cached = prices[key];
  if (!force && cached && Date.now() - cached.fetchedAt < PRICE_TTL) return cached;

  const top = await wfm(`/v2/orders/item/${encodeURIComponent(slug)}/top${qs ? '?' + qs : ''}`);
  // "top" returns the best orders from users who are currently online / in game.
  const sells = top.sell.map((o) => o.platinum).sort((a, b) => a - b);
  const buys = top.buy.map((o) => o.platinum).sort((a, b) => b - a);
  const median = (arr) => (arr.length ? arr[Math.floor((arr.length - 1) / 2)] : null);
  const summary = {
    lowestSell: sells[0] ?? null,
    medianSell: median(sells),
    bestBuy: buys[0] ?? null,
    sellers: sells.length,
    buyers: buys.length,
    fetchedAt: Date.now(),
  };
  prices[key] = summary;
  pricesDirty = true;
  return summary;
}

// ---------- sets ----------

const SETS_FILE = path.join(CACHE_DIR, 'sets.json');
const sets = readJson(SETS_FILE, {});

async function getSet(slug) {
  if (sets[slug]) return sets[slug];
  const data = await wfm(`/v2/item/${encodeURIComponent(slug)}/set`);
  const root = data.items.find((i) => i.setRoot);
  const info = root
    ? {
        setSlug: root.slug,
        parts: data.items
          .filter((i) => !i.setRoot)
          .map((i) => ({ slug: i.slug, quantityInSet: i.quantityInSet ?? 1 })),
      }
    : null;
  // Cache under every member slug so later lookups for sibling parts are free.
  for (const i of data.items) sets[i.slug] = info;
  writeJson(SETS_FILE, sets);
  return info;
}

// ---------- user orders ----------

let ordersCache = null;

async function getMyOrders(force) {
  if (!force && ordersCache && Date.now() - ordersCache.fetchedAt < ORDERS_TTL) return ordersCache;
  const orders = await wfm(`/v2/orders/user/${encodeURIComponent(config.username.toLowerCase())}`);
  ordersCache = { fetchedAt: Date.now(), orders };
  return ordersCache;
}

// ---------- inventory ----------

const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');

// Turns a raw Warframe inventory export (the JSON the game client downloads,
// as saved by tools that export it) into market items, matched by internal path.
async function importGameInventory(json) {
  const index = await gameRefIndex();
  const found = new Map();
  let scanned = 0;
  let unmatched = 0;

  const add = (item, qty, rank) => {
    const key = `${item.slug}|${rank ?? ''}`;
    const prev = found.get(key);
    if (prev) prev.qty += qty;
    else found.set(key, { slug: item.slug, qty, rank: rank ?? null });
  };

  // Only these sections hold tradable, unbuilt things. Equipped gear (LongGuns,
  // Suits, ...) shares paths with market "sets" but can't be traded once built.
  const SECTIONS = ['MiscItems', 'Recipes', 'RawUpgrades', 'Upgrades'];
  const hasSections = SECTIONS.some((s) => Array.isArray(json[s]));
  const entries = hasSections ? SECTIONS.flatMap((s) => json[s] ?? []) : (Array.isArray(json) ? json : []);

  for (const e of entries) {
    const ref = e.ItemType ?? e.uniqueName ?? e.itemType;
    if (!ref) continue;
    scanned++;
    const item = index.get(ref);
    if (!item || item.tags.includes('set')) { unmatched++; continue; }
    let rank = null;
    if (item.maxRank !== null) {
      rank = 0;
      try { rank = JSON.parse(e.UpgradeFingerprint ?? '{}').lvl ?? 0; } catch { /* unranked */ }
    }
    const qty = Number(e.ItemCount ?? e.count ?? 1);
    if (qty > 0) add(item, qty, rank);
  }
  return { items: [...found.values()], scanned, unmatched };
}

// ---------- http ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const routes = {
  'GET /api/config': async () => ({ username: config.username, platform: config.platform, priceTtlMinutes: config.priceTtlMinutes }),
  'GET /api/items': async (q) => getItems(q.get('force') === '1'),
  'GET /api/price': async (q) => getPrice(q.get('slug'), q.get('rank'), q.get('subtype'), q.get('force') === '1'),
  'GET /api/set': async (q) => getSet(q.get('slug')),
  'GET /api/my-orders': async (q) => getMyOrders(q.get('force') === '1'),
  'GET /api/inventory': async () => readJson(INVENTORY_FILE, []),
  'PUT /api/inventory': async (q, body) => {
    const inv = JSON.parse(body);
    if (!Array.isArray(inv)) throw Object.assign(new Error('Inventory must be an array'), { status: 400 });
    writeJson(INVENTORY_FILE, inv);
    return { ok: true, count: inv.length };
  },
  'POST /api/import': async (q, body) => importGameInventory(JSON.parse(body)),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const body = req.method === 'GET' ? '' : await readBody(req);
      send(res, 200, await handler(url.searchParams, body));
    } catch (err) {
      console.error(err.message);
      send(res, err.status && err.status < 500 ? err.status : 502, { error: err.message });
    }
    return;
  }

  // Static files from /public
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Warframe Help running at http://localhost:${config.port}  (profile: ${config.username})`);
});
