// Warframe Help — local price checker and lister for warframe.market
// Zero-dependency Node server: proxies the warframe.market API (which has no CORS),
// throttles to their 3 req/s limit, caches results, stores your inventory on disk,
// and (once you connect your account) creates, updates and closes your sell orders.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const API = process.env.WFM_API_URL || 'https://api.warframe.market'; // override only for testing
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

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- upstream access (throttled) ----------

let queue = Promise.resolve();
let lastRequest = 0;
const MIN_GAP_MS = 350; // stays under warframe.market's 3 requests/second

// Readable messages for the error codes warframe.market returns.
const ERROR_TEXT = {
  'app.account.email_not_exist': 'No warframe.market account uses that email.',
  'app.account.password_invalid': 'Wrong password.',
  'app.user.notFound': 'warframe.market has no profile with that name. Check "username" in config.json.',
};

function describeError(body, status) {
  const err = body?.error;
  if (!err) return `warframe.market returned ${status}`;
  if (typeof err === 'string') return ERROR_TEXT[err] ?? err;
  const parts = [];
  for (const [field, codes] of Object.entries(err)) {
    for (const code of [].concat(codes)) parts.push(ERROR_TEXT[code] ?? `${field}: ${code}`);
  }
  return parts.join(' ') || `warframe.market returned ${status}`;
}

// Every request to warframe.market goes through this queue so we never exceed the rate limit.
function upstream(method, pathAndQuery, { body, token, headers = {} } = {}) {
  const run = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = lastRequest + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequest = Date.now();
      const res = await fetch(API + pathAndQuery, {
        method,
        headers: {
          'Language': 'en',
          'Platform': config.platform,
          'Crossplay': 'true',
          'Accept': 'application/json',
          'User-Agent': 'WarframeHelp/1.0 (personal price checker)',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const json = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, ok: res.ok, headers: res.headers, body: json };
    }
    throw httpError(502, `warframe.market kept rate-limiting ${pathAndQuery}`);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function wfm(pathAndQuery, { method = 'GET', body, authed = false } = {}) {
  if (authed && !auth) throw httpError(401, 'Connect your warframe.market account first.');
  const res = await upstream(method, pathAndQuery, { body, token: authed ? auth.token : undefined });
  if (res.status === 401 && authed) {
    setAuth(null);
    throw httpError(401, 'Your warframe.market session expired. Connect your account again.');
  }
  if (!res.ok) throw httpError(res.status, describeError(res.body, res.status));
  return res.body?.data ?? null;
}

// ---------- items ----------

const ITEMS_FILE = path.join(CACHE_DIR, 'items.json');
let itemsCache = readJson(ITEMS_FILE, null);
let itemIndex = null;

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
  itemIndex = null;
  writeJson(ITEMS_FILE, itemsCache);
  return items;
}

async function itemBySlug(slug) {
  if (!itemIndex) itemIndex = new Map((await getItems()).map((i) => [i.slug, i]));
  const item = itemIndex.get(slug);
  if (!item) throw httpError(400, `Unknown item: ${slug}`);
  return item;
}

// ---------- prices ----------

const PRICES_FILE = path.join(CACHE_DIR, 'prices.json');
const prices = readJson(PRICES_FILE, {});
let pricesDirty = false;
setInterval(() => {
  if (pricesDirty) { writeJson(PRICES_FILE, prices); pricesDirty = false; }
}, 5000).unref();

function priceKey(slug, rank, subtype) {
  const params = new URLSearchParams();
  if (rank !== null && rank !== undefined && rank !== '') params.set('rank', rank);
  if (subtype) params.set('subtype', subtype);
  return { key: `${slug}?${params}`, qs: params.toString() };
}

async function getPrice(slug, rank, subtype, force) {
  const { key, qs } = priceKey(slug, rank, subtype);
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

// Everything in the price cache regardless of age, so the page can show it instantly on load.
function cachedPrices() {
  return Object.entries(prices).map(([key, summary]) => {
    const [slug, qs] = key.split('?');
    const params = new URLSearchParams(qs);
    return {
      slug,
      rank: params.has('rank') ? Number(params.get('rank')) : null,
      subtype: params.get('subtype'),
      ...summary,
    };
  });
}

// ---------- sets ----------

const SETS_FILE = path.join(CACHE_DIR, 'sets.json');
const sets = readJson(SETS_FILE, {});

async function getSet(slug) {
  if (sets[slug] !== undefined) return sets[slug];
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
  sets[slug] = info;
  writeJson(SETS_FILE, sets);
  return info;
}

// ---------- account ----------

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
let auth = readJson(AUTH_FILE, null); // { token, deviceId, user: { ingameName, slug } }
let authVerified = false;

function setAuth(value) {
  auth = value;
  authVerified = !!value;
  if (value) writeJson(AUTH_FILE, value);
  else fs.rmSync(AUTH_FILE, { force: true });
  ordersCache = null;
}

async function login(email, password) {
  if (!email || !password) throw httpError(400, 'Enter your email and password.');
  const deviceId = auth?.deviceId ?? `wfhelp-${crypto.randomUUID()}`;
  const res = await upstream('POST', '/v1/auth/signin', {
    body: { auth_type: 'header', email, password, device_id: deviceId },
    headers: { 'Authorization': 'JWT' },
  });
  if (!res.ok) throw httpError(res.status === 401 ? 400 : res.status, describeError(res.body, res.status));
  const token = (res.headers.get('authorization') ?? '').replace(/^JWT\s+/i, '');
  if (!token) throw httpError(502, 'warframe.market did not return a session token.');
  const u = res.body?.payload?.user ?? {};
  // Only the session token is kept, never the password.
  setAuth({ token, deviceId, user: { ingameName: u.ingame_name, slug: u.slug ?? u.ingame_name?.toLowerCase() } });
  await verifyAuth();
  return authStatus();
}

// For accounts that sign in with Steam/Google/Discord and have no password: use the session token
// copied from the browser's warframe.market cookie. It is checked against /v2/me before being kept.
async function loginWithToken(raw) {
  const token = String(raw ?? '').trim().replace(/^(JWT|Bearer)\s+/i, '').replace(/^"|"$/g, '');
  if (!token) throw httpError(400, 'Paste the token first.');
  const res = await upstream('GET', '/v2/me', { token });
  if (res.status === 401 || res.status === 403) {
    throw httpError(400, 'warframe.market did not accept that token. Copy the cookie value again while logged in, or check you copied the whole value.');
  }
  if (!res.ok) throw httpError(res.status, describeError(res.body, res.status));
  const me = res.body?.data ?? {};
  setAuth({ token, deviceId: auth?.deviceId ?? `wfhelp-${crypto.randomUUID()}`, user: { ingameName: me.ingameName, slug: me.slug } });
  return authStatus();
}

// Confirms a saved token still works and refreshes the profile name.
async function verifyAuth() {
  if (!auth || authVerified) return;
  try {
    const me = await wfm('/v2/me', { authed: true });
    auth.user = { ingameName: me.ingameName, slug: me.slug };
    writeJson(AUTH_FILE, auth);
    authVerified = true;
  } catch (err) {
    if (err.status !== 401) throw err; // network trouble: keep the token, try again later
  }
}

function authStatus() {
  return auth ? { connected: true, user: auth.user } : { connected: false, user: null };
}

function profileSlug() {
  return auth?.user?.slug ?? config.username.toLowerCase();
}

// ---------- your orders + sale detection ----------

// We remember your sell orders between fetches. If one shrinks or disappears without this app
// doing it, you probably marked it sold on the website, and the page asks or updates the list.
const SNAPSHOT_FILE = path.join(DATA_DIR, 'orders-snapshot.json');
let snapshot = readJson(SNAPSHOT_FILE, null); // { owner, authed, orders: { [id]: {...} } }
let ordersCache = null;

const snapOrder = (o) => ({ itemId: o.itemId, rank: o.rank ?? null, subtype: o.subtype ?? null, quantity: o.quantity, platinum: o.platinum });

function saveSnapshot() { writeJson(SNAPSHOT_FILE, snapshot); }

function diffSnapshot(orders) {
  const owner = profileSlug();
  const authed = !!auth;
  const current = {};
  for (const o of orders) if (o.type === 'sell') current[o.id] = snapOrder(o);

  const events = [];
  if (snapshot && snapshot.owner === owner && snapshot.authed === authed) {
    for (const [id, old] of Object.entries(snapshot.orders)) {
      const now = current[id];
      if (!now) events.push({ kind: 'gone', orderId: id, ...old });
      else if (now.quantity < old.quantity) events.push({ kind: 'sold', orderId: id, ...old, quantity: old.quantity - now.quantity });
    }
  }
  snapshot = { owner, authed, orders: current };
  saveSnapshot();
  return events;
}

// Keeps the snapshot in step with changes this app makes, so they aren't mistaken for sales.
function snapshotApply(id, order) {
  if (!snapshot) return;
  if (order && order.quantity > 0) snapshot.orders[id] = snapOrder(order);
  else delete snapshot.orders[id];
  saveSnapshot();
}

async function getMyOrders(force) {
  await verifyAuth();
  if (!force && ordersCache && Date.now() - ordersCache.fetchedAt < ORDERS_TTL) {
    return { ...ordersCache, events: [] };
  }
  const orders = auth
    ? await wfm('/v2/orders/my', { authed: true })
    : await wfm(`/v2/orders/user/${encodeURIComponent(profileSlug())}`);
  const events = diffSnapshot(orders);
  ordersCache = { fetchedAt: Date.now(), orders, authed: !!auth };
  return { ...ordersCache, events };
}

async function createOrder({ slug, platinum, quantity, rank, subtype, visible = true }) {
  const item = await itemBySlug(slug);
  const body = {
    itemId: item.id,
    type: 'sell',
    platinum: Math.round(Number(platinum)),
    quantity: Math.max(1, Math.round(Number(quantity) || 1)),
    visible: !!visible,
  };
  if (!(body.platinum >= 1)) throw httpError(400, 'Price must be at least 1 platinum.');
  if (item.maxRank !== null && rank !== null && rank !== undefined) body.rank = Number(rank);
  if (item.subtypes && subtype) body.subtype = subtype;
  const order = await wfm('/v2/order', { method: 'POST', body, authed: true });
  snapshotApply(order.id, order);
  ordersCache = null;
  return order;
}

async function updateOrder(id, { platinum, quantity, visible }) {
  const body = {};
  if (platinum !== undefined) body.platinum = Math.round(Number(platinum));
  if (quantity !== undefined) body.quantity = Math.max(1, Math.round(Number(quantity)));
  if (visible !== undefined) body.visible = !!visible;
  const order = await wfm(`/v2/order/${encodeURIComponent(id)}`, { method: 'PATCH', body, authed: true });
  snapshotApply(id, order);
  ordersCache = null;
  return order;
}

async function deleteOrder(id) {
  await wfm(`/v2/order/${encodeURIComponent(id)}`, { method: 'DELETE', authed: true });
  snapshotApply(id, null);
  ordersCache = null;
  return { ok: true };
}

// "Close" is warframe.market's "mark as sold": it lowers the quantity and records the trade.
async function closeOrder(id, quantity) {
  const qty = Math.max(1, Math.round(Number(quantity) || 1));
  const result = await wfm(`/v2/order/${encodeURIComponent(id)}/close`, { method: 'POST', body: { quantity: qty }, authed: true });
  const old = snapshot?.orders[id];
  if (old) snapshotApply(id, { ...old, quantity: old.quantity - qty });
  ordersCache = null;
  return result;
}

// ---------- inventory + sales history ----------

const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');
const SALES_FILE = path.join(DATA_DIR, 'sales.json');

function saveInventory(inv) {
  if (!Array.isArray(inv)) throw httpError(400, 'Inventory must be an array');
  writeJson(INVENTORY_FILE, inv);
  return { ok: true, count: inv.length };
}

// ---------- http ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// [method, path pattern, handler(params, query, body)]
const routes = [
  ['GET', '/api/config', async () => ({ username: profileSlug(), platform: config.platform, priceTtlMinutes: config.priceTtlMinutes })],
  ['GET', '/api/items', async (p, q) => getItems(q.get('force') === '1')],
  ['GET', '/api/price', async (p, q) => getPrice(q.get('slug'), q.get('rank'), q.get('subtype'), q.get('force') === '1')],
  ['GET', '/api/prices/cached', async () => cachedPrices()],
  ['GET', '/api/set', async (p, q) => getSet(q.get('slug'))],

  ['GET', '/api/auth', async () => { await verifyAuth().catch(() => {}); return authStatus(); }],
  ['POST', '/api/auth/login', async (p, q, b) => login(b.email, b.password)],
  ['POST', '/api/auth/token', async (p, q, b) => loginWithToken(b.token)],
  ['POST', '/api/auth/logout', async () => { setAuth(null); return authStatus(); }],

  ['GET', '/api/my-orders', async (p, q) => getMyOrders(q.get('force') === '1')],
  ['POST', '/api/orders', async (p, q, b) => createOrder(b)],
  ['PATCH', '/api/orders/:id', async (p, q, b) => updateOrder(p.id, b)],
  ['DELETE', '/api/orders/:id', async (p) => deleteOrder(p.id)],
  ['POST', '/api/orders/:id/close', async (p, q, b) => closeOrder(p.id, b.quantity)],

  ['GET', '/api/inventory', async () => readJson(INVENTORY_FILE, [])],
  ['PUT', '/api/inventory', async (p, q, inv) => saveInventory(inv)],
  ['POST', '/api/inventory', async (p, q, inv) => saveInventory(inv)], // sendBeacon on page close can only POST
  ['GET', '/api/sales', async () => readJson(SALES_FILE, [])],
  ['POST', '/api/sales', async (p, q, b) => {
    const sales = readJson(SALES_FILE, []);
    sales.push(...[].concat(b.sales ?? []).map((s) => ({ ...s, at: s.at ?? new Date().toISOString() })));
    writeJson(SALES_FILE, sales);
    return { ok: true, count: sales.length };
  }],
].map(([method, pattern, handler]) => {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { method, re, names, handler };
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const body = req.method === 'GET' ? {} : await readBody(req);
      send(res, 200, await r.handler(params, url.searchParams, body));
    } catch (err) {
      console.error(err.message);
      send(res, err.status && err.status < 600 ? err.status : 502, { error: err.message });
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) { send(res, 404, { error: 'Not found' }); return; }

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
  console.log(`Warframe Help running at http://localhost:${config.port}  (profile: ${profileSlug()})`);
});
