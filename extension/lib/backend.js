'use strict';
/* global browser */
// Everything the add-on needs from warframe.market. It runs inside the extension (the app page and the
// background script both load it), keeps data in browser.storage.local, and signs requests with the
// session the user already has on warframe.market, so no password ever passes through the add-on.

const Backend = (() => {
  const API = 'https://api.warframe.market';
  const SITE = 'https://warframe.market';
  const ITEMS_TTL = 24 * 60 * 60 * 1000;
  const ORDERS_TTL = 60 * 1000;
  const PRICE_TTL_MINUTES = 30;
  const MIN_GAP_MS = 350; // stays under warframe.market's 3 requests/second

  // ---------- storage ----------

  const store = {
    async get(key, fallback) {
      const result = await browser.storage.local.get(key);
      return result[key] ?? fallback;
    },
    set: (key, value) => browser.storage.local.set({ [key]: value }),
  };

  function httpError(status, message) {
    return Object.assign(new Error(message), { status });
  }

  let settings = null;
  async function getSettings({ fresh = false } = {}) {
    if (fresh) settings = null;
    settings ??= { platform: 'pc', ...(await store.get('settings', {})) };
    return settings;
  }
  async function updateSettings(patch) {
    settings = { ...(await getSettings()), ...patch };
    await store.set('settings', settings);
    if ('platform' in patch) { prices = {}; stats = {}; await store.set('prices', {}); await store.set('stats', {}); ordersCache = null; }
    return settings;
  }

  // ---------- requests (throttled) ----------

  const ERROR_TEXT = {
    'app.user.notFound': 'warframe.market has no profile with that name.',
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

  let queue = Promise.resolve();
  let lastRequest = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function upstream(method, path, { body, token, language = 'en' } = {}) {
    const run = async () => {
      const { platform } = await getSettings();
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = lastRequest + MIN_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequest = Date.now();
        let res;
        try {
          res = await fetch(API + path, {
            method,
            credentials: 'omit', // we authenticate with the Authorization header, never cookies
            headers: {
              'Language': language,
              'Platform': platform,
              'Crossplay': 'true',
              'Accept': 'application/json',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
        } catch {
          throw httpError(0, 'Could not reach warframe.market. Check your connection, and that the add-on is allowed to access warframe.market.');
        }
        if (res.status === 429 || res.status >= 500) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        const json = res.status === 204 ? null : await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, body: json };
      }
      throw httpError(503, 'warframe.market is busy right now. Try again in a minute.');
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  async function wfm(path, { method = 'GET', body, authed = false, language } = {}) {
    let token;
    if (authed) {
      const auth = await getAuth();
      if (!auth.connected) throw httpError(401, 'Log in on warframe.market first.');
      token = auth.token;
    }
    const res = await upstream(method, path, { body, token, language });
    if (res.status === 401 && authed) {
      verified = { token: null, user: null };
      throw httpError(401, 'Your warframe.market session ended. Log in on warframe.market again.');
    }
    if (!res.ok) throw httpError(res.status, describeError(res.body, res.status));
    return res.body?.data ?? null;
  }

  // ---------- account (from the warframe.market session cookie) ----------

  const ACCESS = { origins: [`${API}/*`, `${SITE}/*`] };
  const hasAccess = () => browser.permissions.contains(ACCESS);
  // Must be called straight from a click handler: browsers only show permission prompts for user actions.
  const requestAccess = () => browser.permissions.request(ACCESS);

  async function readSessionCookie() {
    const query = { url: SITE, name: 'JWT' };
    try {
      return await browser.cookies.get(query);
    } catch (err) {
      // With first-party isolation turned on (privacy.firstparty.isolate), cookies need their first-party domain.
      if (/firstPartyDomain/i.test(err.message)) return browser.cookies.get({ ...query, firstPartyDomain: 'warframe.market' });
      throw err;
    }
  }

  let verified = { token: null, user: null };

  async function getAuth() {
    if (!(await hasAccess())) return { connected: false, user: null, reason: 'no-access' };
    const cookie = await readSessionCookie().catch(() => null);
    if (!cookie?.value) return { connected: false, user: null, reason: 'logged-out' };
    if (verified.token === cookie.value) return { connected: true, user: verified.user, token: cookie.value };
    const res = await upstream('GET', '/v2/me', { token: cookie.value });
    if (res.status === 401 || res.status === 403) return { connected: false, user: null, reason: 'logged-out' };
    if (!res.ok) throw httpError(res.status, describeError(res.body, res.status));
    const me = res.body?.data ?? {};
    if (!me.slug) return { connected: false, user: null, reason: 'logged-out' }; // anonymous session
    verified = { token: cookie.value, user: { ingameName: me.ingameName, slug: me.slug } };
    await store.set('lastUser', verified.user);
    return { connected: true, user: verified.user, token: cookie.value };
  }

  async function authStatus() {
    const { connected, user, reason } = await getAuth();
    return { connected, user, reason };
  }

  // ---------- items ----------

  let itemsCache = null;
  let itemIndex = null;

  async function getItems(force = false) {
    itemsCache ??= await store.get('items', null);
    if (!force && itemsCache && Date.now() - itemsCache.fetchedAt < ITEMS_TTL) return itemsCache.items;
    const raw = await wfm('/v2/items');
    const items = raw.map((i) => ({
      id: i.id,
      slug: i.slug,
      name: i.i18n?.en?.name ?? i.slug,
      thumb: i.i18n?.en?.thumb ?? null,
      tags: i.tags ?? [],
      maxRank: i.maxRank ?? null,
      ducats: i.ducats ?? null,
      subtypes: i.subtypes ?? null,
      vaulted: i.vaulted ?? false,
    }));
    itemsCache = { fetchedAt: Date.now(), items };
    itemIndex = null;
    await store.set('items', itemsCache);
    return items;
  }

  // Item names in another game language (for reading screenshots of a non-English game), as { slug: name }.
  async function getItemNames(language) {
    const key = `itemNames:${language}`;
    const cached = await store.get(key, null);
    if (cached && Date.now() - cached.fetchedAt < ITEMS_TTL) return cached.names;
    const raw = await wfm('/v2/items', { language });
    const names = {};
    for (const i of raw) names[i.slug] = i.i18n?.[language]?.name ?? i.i18n?.en?.name ?? i.slug;
    await store.set(key, { fetchedAt: Date.now(), names });
    return names;
  }

  async function itemIndexes() {
    if (!itemIndex) {
      const items = await getItems();
      itemIndex = { bySlug: new Map(items.map((i) => [i.slug, i])), byId: new Map(items.map((i) => [i.id, i])) };
    }
    return itemIndex;
  }

  async function itemBySlug(slug) {
    const item = (await itemIndexes()).bySlug.get(slug);
    if (!item) throw httpError(400, `Unknown item: ${slug}`);
    return item;
  }

  // ---------- prices ----------

  let prices = null;
  let pricesSaveTimer = null;
  async function loadPrices() { prices ??= await store.get('prices', {}); return prices; }
  function savePricesSoon() {
    clearTimeout(pricesSaveTimer);
    pricesSaveTimer = setTimeout(() => store.set('prices', prices), 1000);
  }

  function priceKey(slug, rank, subtype) {
    const params = new URLSearchParams();
    if (rank !== null && rank !== undefined && rank !== '') params.set('rank', rank);
    if (subtype) params.set('subtype', subtype);
    return { key: `${slug}?${params}`, qs: params.toString() };
  }

  async function getPrice(slug, rank, subtype, force = false) {
    await loadPrices();
    const { key, qs } = priceKey(slug, rank, subtype);
    const cached = prices[key];
    if (!force && cached && Date.now() - cached.fetchedAt < PRICE_TTL_MINUTES * 60 * 1000) return cached;

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
      // Who those sellers are, so your own listing can be left out when pricing against the others.
      sellOrders: top.sell.map((o) => ({ platinum: o.platinum, user: o.user?.slug ?? null })),
      fetchedAt: Date.now(),
    };
    prices[key] = summary;
    savePricesSoon();
    return summary;
  }

  // Everything in the price cache regardless of age, so the page can show it instantly.
  async function cachedPrices() {
    await loadPrices();
    return Object.entries(prices).map(([key, summary]) => {
      const [slug, qs] = key.split('?');
      const params = new URLSearchParams(qs);
      return { slug, rank: params.has('rank') ? Number(params.get('rank')) : null, subtype: params.get('subtype'), ...summary };
    });
  }

  // ---------- price history ----------

  // Completed trades per day (people marking orders sold on warframe.market). Only the older v1 API has
  // this; if it ever goes away, history just stays empty. One request covers every rank and refinement.
  const STATS_TTL = 6 * 60 * 60 * 1000;
  const STATS_DAYS = 8;
  let stats = null;
  let statsSaveTimer = null;

  async function getStats(slug, force = false) {
    stats ??= await store.get('stats', {});
    const cached = stats[slug];
    if (!force && cached && Date.now() - cached.fetchedAt < STATS_TTL) return cached;
    const res = await upstream('GET', `/v1/items/${encodeURIComponent(slug)}/statistics`);
    if (!res.ok) throw httpError(res.status, describeError(res.body, res.status));
    const since = Date.now() - STATS_DAYS * 24 * 60 * 60 * 1000;
    const days = (res.body?.payload?.statistics_closed?.['90days'] ?? [])
      .filter((d) => Date.parse(d.datetime) >= since)
      .map((d) => ({ at: Date.parse(d.datetime), volume: d.volume, price: d.wa_price ?? d.avg_price, rank: d.mod_rank ?? null, subtype: d.subtype ?? null }));
    stats[slug] = { fetchedAt: Date.now(), days };
    clearTimeout(statsSaveTimer);
    statsSaveTimer = setTimeout(() => store.set('stats', stats), 1000);
    return stats[slug];
  }

  async function cachedStats() {
    stats ??= await store.get('stats', {});
    return stats;
  }

  // ---------- sets ----------

  async function getSet(slug) {
    const sets = await store.get('sets', {});
    if (sets[slug] !== undefined) return sets[slug];
    const data = await wfm(`/v2/item/${encodeURIComponent(slug)}/set`);
    const root = data.items.find((i) => i.setRoot);
    const info = root
      ? { setSlug: root.slug, parts: data.items.filter((i) => !i.setRoot).map((i) => ({ slug: i.slug, quantityInSet: i.quantityInSet ?? 1 })) }
      : null;
    // Cache under every member slug so later lookups for sibling parts are free.
    for (const i of data.items) sets[i.slug] = info;
    sets[slug] = info;
    await store.set('sets', sets);
    return info;
  }

  // ---------- inventory + sales ----------

  const getInventory = () => store.get('inventory', []);
  const saveInventory = (inv) => store.set('inventory', inv);
  const getSales = () => store.get('sales', []);

  async function addSales(list) {
    const sales = await getSales();
    sales.push(...list.map((s) => ({ ...s, at: s.at ?? new Date().toISOString() })));
    await store.set('sales', sales);
    return sales;
  }

  // ---------- your orders + sale detection ----------

  // We remember your sell orders between checks. If one shrinks or disappears without the add-on doing it,
  // you most likely marked it sold on the website: a lower quantity is removed from your list straight away,
  // a vanished order is flagged so you can confirm (deleted and sold-out orders look the same).
  let ordersCache = null;

  const snapOrder = (o) => ({ itemId: o.itemId, rank: o.rank ?? null, subtype: o.subtype ?? null, quantity: o.quantity, platinum: o.platinum });

  async function diffSnapshot(orders, owner, authed) {
    const snapshot = await store.get('ordersSnapshot', null);
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
    await store.set('ordersSnapshot', { owner, authed, orders: current });
    return events;
  }

  // Keeps the snapshot in step with changes the add-on makes itself, so they aren't mistaken for sales.
  async function snapshotApply(id, order) {
    const snapshot = await store.get('ordersSnapshot', null);
    if (!snapshot) return;
    if (order && order.quantity > 0) snapshot.orders[id] = snapOrder(order);
    else delete snapshot.orders[id];
    await store.set('ordersSnapshot', snapshot);
  }

  async function applyOrderEvents(events) {
    const { byId } = await itemIndexes();
    let inventory = await getInventory();
    const sold = [], gone = [], sales = [];
    for (const ev of events) {
      const item = byId.get(ev.itemId);
      if (!item) continue;
      const same = inventory.filter((e) => e.slug === item.slug);
      const entry = same.find((e) => (ev.rank ?? null) === (e.rank ?? null) && (ev.subtype ?? null) === (e.subtype ?? null))
        || (same.length === 1 ? same[0] : null);
      if (!entry) continue;
      if (ev.kind === 'sold') {
        sales.push({ slug: item.slug, name: item.name, qty: ev.quantity, platinum: ev.platinum, how: 'marked sold on warframe.market' });
        entry.qty -= ev.quantity;
        if (entry.qty <= 0) inventory = inventory.filter((e) => e !== entry);
        sold.push({ slug: item.slug, name: item.name, qty: ev.quantity, platinum: ev.platinum });
      } else {
        entry.gone = { quantity: ev.quantity, platinum: ev.platinum };
        gone.push({ slug: item.slug, name: item.name, qty: ev.quantity, platinum: ev.platinum });
      }
    }
    if (sold.length || gone.length) await saveInventory(inventory);
    if (sales.length) await addSales(sales);
    return { sold, gone };
  }

  // Fetches your orders, notices sales made on the website and updates the stored list accordingly.
  async function checkOrders(force = false) {
    if (!force && ordersCache && Date.now() - ordersCache.fetchedAt < ORDERS_TTL) {
      return { ...ordersCache, sold: [], gone: [] };
    }
    const auth = await getAuth();
    const owner = auth.user?.slug ?? (await store.get('lastUser', null))?.slug;
    if (!owner) return { orders: [], authed: false, sold: [], gone: [] };
    const orders = auth.connected
      ? await wfm('/v2/orders/my', { authed: true })
      : await wfm(`/v2/orders/user/${encodeURIComponent(owner)}`);
    const events = await diffSnapshot(orders, owner, auth.connected);
    const { sold, gone } = await applyOrderEvents(events);
    ordersCache = { fetchedAt: Date.now(), orders, authed: auth.connected };
    return { ...ordersCache, sold, gone };
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
    await snapshotApply(order.id, order);
    ordersCache = null;
    return order;
  }

  async function updateOrder(id, { platinum, quantity, visible }) {
    const body = {};
    if (platinum !== undefined) body.platinum = Math.round(Number(platinum));
    if (quantity !== undefined) body.quantity = Math.max(1, Math.round(Number(quantity)));
    if (visible !== undefined) body.visible = !!visible;
    const order = await wfm(`/v2/order/${encodeURIComponent(id)}`, { method: 'PATCH', body, authed: true });
    await snapshotApply(id, order);
    ordersCache = null;
    return order;
  }

  async function deleteOrder(id) {
    await wfm(`/v2/order/${encodeURIComponent(id)}`, { method: 'DELETE', authed: true });
    await snapshotApply(id, null);
    ordersCache = null;
  }

  // "Close" is warframe.market's "mark as sold": it lowers the quantity and records the trade.
  async function closeOrder(id, quantity) {
    const qty = Math.max(1, Math.round(Number(quantity) || 1));
    const result = await wfm(`/v2/order/${encodeURIComponent(id)}/close`, { method: 'POST', body: { quantity: qty }, authed: true });
    const snapshot = await store.get('ordersSnapshot', null);
    const old = snapshot?.orders[id];
    if (old) await snapshotApply(id, { ...old, quantity: old.quantity - qty });
    ordersCache = null;
    return result;
  }

  // ---------- backup ----------

  async function exportData() {
    return { app: 'tenno-trade-helper', version: 1, exportedAt: new Date().toISOString(), inventory: await getInventory(), sales: await getSales() };
  }

  // Accepts a backup from exportData(), or the inventory.json / sales.json files of the old local app.
  async function importData(data, { replace = true } = {}) {
    let inventory = null, sales = null;
    if (Array.isArray(data)) {
      if (data.every((x) => x && typeof x.slug === 'string' && 'qty' in x)) inventory = data;
      else if (data.every((x) => x && typeof x.slug === 'string' && 'at' in x)) sales = data;
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.inventory)) inventory = data.inventory;
      if (Array.isArray(data.sales)) sales = data.sales;
    }
    if (!inventory && !sales) throw httpError(400, 'That file is not a Tenno Trade Helper backup.');
    if (inventory) await saveInventory(replace ? inventory : [...(await getInventory()), ...inventory]);
    if (sales) await store.set('sales', replace ? sales : [...(await getSales()), ...sales]);
    return { inventory: inventory?.length ?? 0, sales: sales?.length ?? 0 };
  }

  return {
    SITE,
    PRICE_TTL_MINUTES,
    getSettings, updateSettings,
    hasAccess, requestAccess, authStatus,
    getItems, getItemNames, getPrice, cachedPrices, getStats, cachedStats, STATS_TTL, getSet,
    getInventory, saveInventory, getSales, addSales,
    checkOrders, createOrder, updateOrder, deleteOrder, closeOrder,
    exportData, importData,
  };
})();
