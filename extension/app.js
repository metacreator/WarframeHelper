'use strict';
/* global browser, Backend, h, fill, t, tk, setPageLang, guessLanguage, translatePage, PAGE_LANGS */

const ASSETS = 'https://warframe.market/static/assets/';
const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  auth: { connected: false, user: null, reason: null },
  items: [],
  bySlug: new Map(),
  byId: new Map(),
  byName: new Map(),    // lower-case English name -> item
  names: null,          // { slug: name } in the page language; null = English
  byLocalName: new Map(),
  inventory: [],        // [{ slug, qty, rank, subtype, price, gone }]
  prices: new Map(),    // rowKey -> price summary
  loadingPrices: new Set(),
  stats: new Map(),     // slug -> { fetchedAt, days: [{ at, volume, price, rank, subtype }] } completed trades
  loadingStats: new Set(),
  busyRows: new Set(),  // rows with a listing request in flight
  listings: new Map(),  // slug -> [your sell orders]
  sales: [],
  sort: { col: 'value', dir: -1 },
  refreshing: false,
};

// ---------- helpers ----------

const dash = () => h('span', { class: 'muted' }, '—');
const fmt = (n) => (n === null || n === undefined ? dash() : n.toLocaleString());
const plat = (n, tag = 'span') => h(tag, { class: 'plat' }, n);

function category(item) {
  const tags = item.tags;
  if (tags.includes('prime') && tags.includes('set')) return 'Prime Set';
  // Main blueprints ("Hydroid Prime Blueprint") are tagged "blueprint" rather than "component".
  if (tags.includes('prime') && (tags.includes('component') || tags.includes('blueprint'))) return 'Prime Part';
  if (tags.includes('mod')) return 'Mod';
  if (tags.includes('arcane_enhancement')) return 'Arcane';
  if (tags.includes('relic')) return 'Relic';
  return 'Other';
}

const CATEGORY_LABELS = {
  'Prime Part': tk('Prime parts'), 'Prime Set': tk('Prime sets'), Mod: tk('Mods'), Arcane: tk('Arcanes'), Relic: tk('Relics'), Other: tk('Other'),
};
// Shown translated; stored or sent in English: relic refinements, sale notes, messages from lib/backend.js.
tk('intact'); tk('exceptional'); tk('flawless'); tk('radiant');
tk('marked sold on warframe.market');
tk('Log in on warframe.market first.');
tk('Your warframe.market session ended. Log in on warframe.market again.');
tk('Could not reach warframe.market. Check your connection, and that the add-on is allowed to access warframe.market.');
tk('warframe.market is busy right now. Try again in a minute.');
tk('Price must be at least 1 platinum.');
tk('That file is not a Tenno Trade Helper backup.');
const HOW = {
  soldHere: tk('marked sold in Tenno Trade Helper'),
  goneSold: tk('confirmed after listing disappeared'),
  baro: tk("traded to Baro Ki'Teer"),
};
const errText = (err) => t(err.message);

// Item names in the page language (warframe.market's own translations); English until they're loaded.
const itemName = (item) => state.names?.[item.slug] ?? item.name;

const isRanked = (item) => item.maxRank !== null;
const defaultSubtype = (item) => (item.subtypes ? item.subtypes[0] : null);

function normalizeEntry(e) {
  const item = state.bySlug.get(e.slug);
  const price = Number(e.price);
  const qty = Math.max(1, Number(e.qty) || 1);
  const listQty = Number(e.listQty);
  return {
    slug: e.slug,
    qty,
    // How many to put on the market; null = all of them.
    listQty: e.listQty !== null && e.listQty !== undefined && e.listQty !== '' && listQty >= 1 ? Math.min(Math.round(listQty), qty) : null,
    rank: isRanked(item) ? Math.min(item.maxRank, Math.max(0, Number(e.rank) || 0)) : null,
    // Screenshots don't show a mod's or arcane's rank, and rank 0 vs max can differ hugely in price, so a
    // ranked item can't be listed until its rank was typed in or comes from an existing listing.
    rankKnown: isRanked(item) ? !!e.rankKnown : true,
    subtype: item.subtypes ? (item.subtypes.includes(e.subtype) ? e.subtype : defaultSubtype(item)) : null,
    price: e.price !== null && e.price !== undefined && e.price !== '' && price >= 1 ? Math.round(price) : null,
    gone: e.gone ?? null,
  };
}

const rowKey = (e) => `${e.slug}|${e.rank ?? ''}|${e.subtype ?? ''}`;
const listQtyOf = (e) => e.listQty ?? e.qty;
const findEntry = (key) => state.inventory.find((e) => rowKey(e) === key);

function setStatus(text) { $('#status').textContent = text; }

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return t('just now');
  if (min < 60) return t('{n} min ago', { n: min });
  const hours = Math.round(min / 60);
  return hours < 48 ? t('{n} h ago', { n: hours }) : t('{n} days ago', { n: Math.round(hours / 24) });
}

function storageGet(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

// ---------- inventory persistence ----------

// Saves run one after another so they can't land out of order; each stores the list as it is then.
let saveChain = Promise.resolve();
function saveInventory() {
  saveChain = saveChain
    .then(() => Backend.saveInventory(state.inventory))
    .catch((err) => setStatus(t('Could not save: {error}', { error: errText(err) })));
  return saveChain;
}

async function reloadInventory() {
  state.inventory = (await Backend.getInventory()).filter((e) => state.bySlug.has(e.slug)).map(normalizeEntry);
}

// setQty: overwrite the quantity of items already in the list instead of adding to it (used by re-scans),
// except for entries marked qtyKnown: false (no count was visible on the screenshot): those keep theirs.
function addEntries(entries, { replace = false, setQty = false } = {}) {
  if (replace) state.inventory = [];
  const added = [];
  for (const raw of entries) {
    if (!state.bySlug.has(raw.slug)) continue;
    const e = normalizeEntry(raw);
    let existing = state.inventory.find((x) => rowKey(x) === rowKey(e));
    // Rank unknown (scans): reuse the single existing row for that item. Relics differ by refinement
    // instead, which scans do give, so a Radiant one never lands on the Intact row.
    if (!existing && isRanked(state.bySlug.get(e.slug)) && (raw.rank === null || raw.rank === undefined)) {
      const sameItem = state.inventory.filter((x) => x.slug === e.slug);
      if (sameItem.length === 1) existing = sameItem[0];
    }
    if (existing) {
      if (!setQty) existing.qty += e.qty;
      else if (raw.qtyKnown !== false) existing.qty = e.qty;
      existing.rankKnown ||= e.rankKnown;
      Object.assign(existing, normalizeEntry(existing)); // keeps "List qty" within a lowered quantity
    } else { state.inventory.push(e); added.push(e); }
  }
  saveInventory();
  render();
  fetchPrices(added);
}

// Lowers an item's quantity after a sale; the row disappears when none are left.
function removeQuantity(entry, qty) {
  entry.qty -= qty;
  if (entry.qty <= 0) state.inventory = state.inventory.filter((e) => e !== entry);
  else Object.assign(entry, normalizeEntry(entry)); // keeps "List qty" within what's left
  saveInventory();
}

// ---------- name lookup (for typed names, in English or the page language) ----------

function findItem(text) {
  const q = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\bbp\b/g, 'blueprint');
  if (!q) return null;
  const exact = state.byLocalName.get(q) || state.byName.get(q) || state.byName.get(q + ' blueprint') || state.bySlug.get(q.replace(/ /g, '_'));
  if (exact) return exact;
  const words = q.split(' ');
  const names = (i) => [i.name.toLowerCase(), itemName(i).toLowerCase()];
  const candidates = state.items.filter((i) => names(i).some((n) => words.every((w) => n.includes(w))));
  if (candidates.length === 1) return candidates[0];
  const prefixed = candidates.filter((i) => names(i).some((n) => n.startsWith(q)));
  if (prefixed.length === 1) return prefixed[0];
  return null;
}

// ---------- prices (cached, shown instantly, refreshed when stale) ----------

const isStale = (p) => !p || p.error || Date.now() - p.fetchedAt > Backend.PRICE_TTL_MINUTES * 60 * 1000;

async function loadCachedPrices() {
  state.prices.clear();
  for (const p of await Backend.cachedPrices()) {
    const item = state.bySlug.get(p.slug);
    if (!item) continue;
    const key = rowKey({ slug: p.slug, rank: isRanked(item) ? p.rank : null, subtype: item.subtypes ? p.subtype : null });
    state.prices.set(key, p);
  }
}

async function fetchPrice(entry, force = false) {
  const key = rowKey(entry);
  state.loadingPrices.add(key);
  try {
    state.prices.set(key, await Backend.getPrice(entry.slug, entry.rank, entry.subtype, force));
  } catch (err) {
    if (!state.prices.get(key)?.lowestSell) state.prices.set(key, { error: errText(err) });
  } finally {
    state.loadingPrices.delete(key);
  }
}

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// refetch: ask again even for prices that aren't stale. force: also skip the price cache.
async function fetchPrices(entries, { refetch = false, force = false } = {}) {
  const todo = entries.filter((e) => refetch || isStale(state.prices.get(rowKey(e))));
  if (!todo.length) { fetchStats(entries); return; }
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const e = todo.shift();
      await fetchPrice(e, force);
      done++;
      setStatus(t('Fetching prices… {done} done, {left} left', { done, left: todo.length }));
      renderSoon();
    }
  };
  // Requests are queued to respect the API rate limit; 3 workers keep the queue full.
  await Promise.all([worker(), worker(), worker()]);
  setStatus(t('Prices updated {time}', { time: new Date().toLocaleTimeString() }));
  render();
  fetchStats(entries); // history after prices: it matters less and shares the same request budget
}

// ---------- price history (completed trades, cached for hours) ----------

async function loadCachedStats() {
  state.stats = new Map(Object.entries(await Backend.cachedStats()));
}

async function fetchStats(entries) {
  const slugs = [...new Set(entries.map((e) => e.slug))].filter((slug) => {
    const s = state.stats.get(slug);
    return !state.loadingStats.has(slug) && (!s || Date.now() - s.fetchedAt > Backend.STATS_TTL);
  });
  slugs.forEach((slug) => state.loadingStats.add(slug));
  for (const slug of slugs) {
    try {
      state.stats.set(slug, await Backend.getStats(slug));
    } catch { /* no history for this item right now; prices still work */ }
    state.loadingStats.delete(slug);
    renderSoon();
  }
}

// Trades of this exact rank / refinement over the last 7 days: volume-weighted average price and volume.
function history(e) {
  const s = state.stats.get(e.slug);
  if (!s) return null;
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const days = s.days.filter((d) => d.at >= since && (d.rank === null || d.rank === e.rank) && (d.subtype === null || d.subtype === e.subtype));
  const trades = days.reduce((n, d) => n + d.volume, 0);
  return {
    avg: trades ? Math.round(days.reduce((sum, d) => sum + d.price * d.volume, 0) / trades) : null,
    trades,
    perDay: trades / 7,
  };
}

async function refreshAll() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('#refreshBtn').disabled = true;
  try {
    const force = $('#forceRefresh').checked;
    await loadListings(true);
    await fetchPrices(state.inventory, { refetch: true, force });
    await computeSets();
  } finally {
    state.refreshing = false;
    $('#refreshBtn').disabled = false;
  }
}

// ---------- account (follows your warframe.market login) ----------

async function loadAuth() {
  const before = state.auth;
  state.auth = await Backend.authStatus().catch(() => ({ connected: false, user: null, reason: 'error' }));
  renderAccount();
  return before.connected !== state.auth.connected || before.user?.slug !== state.auth.user?.slug;
}

function renderAccount() {
  const { connected, user, reason } = state.auth;
  $('#accessBanner').hidden = reason !== 'no-access';
  if (connected) {
    const name = h('a', { href: `https://warframe.market/profile/${encodeURIComponent(user.slug)}`, target: '_blank', rel: 'noopener', title: t('Your warframe.market profile') },
      h('b', null, user.ingameName ?? user.slug));
    const [before, after] = t('Connected as {name}').split('{name}');
    fill($('#accountText'), before, name, after);
    $('#accountBtn').hidden = true;
  } else {
    $('#accountText').textContent = reason === 'checking' ? t('Checking your warframe.market login…')
      : reason === 'no-access' ? t('No access to warframe.market yet') : t('Not logged in on warframe.market');
    $('#accountBtn').hidden = reason === 'no-access' || reason === 'checking';
  }
}

function openLoginPage() {
  browser.tabs.create({ url: `${Backend.SITE}/auth/signin` });
  setStatus(t('Log in on warframe.market in the new tab; this page notices automatically.'));
}

function requireAuth() {
  if (state.auth.connected) return true;
  if (state.auth.reason === 'no-access') setStatus(t('Click "Allow access" at the top first.'));
  else openLoginPage();
  return false;
}

// ---------- your listings + sale detection ----------

async function loadListings(force = false) {
  try {
    await saveChain; // the check may edit the stored list, so store ours first
    const { orders, sold, gone } = await Backend.checkOrders(force);
    state.listings.clear();
    for (const o of orders) {
      if (o.type !== 'sell') continue;
      const item = state.byId.get(o.itemId);
      if (!item) continue;
      if (!state.listings.has(item.slug)) state.listings.set(item.slug, []);
      state.listings.get(item.slug).push(o);
    }
    if (sold.length || gone.length) {
      await reloadInventory();
      await loadSales();
      if (sold.length) setStatus(t('Sold on warframe.market: {items}. Removed from your list.', { items: sold.map((s) => `${s.qty}× ${itemName(state.bySlug.get(s.slug) ?? s)}`).join(', ') }));
      else setStatus(t('{n} listings disappeared from warframe.market. Did they sell?', { n: gone.length }));
    }
    addMissingListedItems();
    render();
  } catch (err) {
    if (err.status === 401) await loadAuth();
    setStatus(t('Could not load your listings: {error}', { error: errText(err) }));
  }
}

// Anything you have listed on warframe.market belongs in your list, even if you never scanned or added it:
// listings made on the website (or before installing) get a row with the listed quantity.
function addMissingListedItems() {
  const matched = new Set(state.inventory.map(listingFor).filter(Boolean));
  const missing = [];
  for (const list of state.listings.values()) {
    for (const o of list) {
      if (matched.has(o)) continue;
      const entry = normalizeEntry({ slug: state.byId.get(o.itemId).slug, qty: o.quantity, rank: o.rank ?? null, rankKnown: true, subtype: o.subtype ?? null });
      if (state.inventory.some((e) => rowKey(e) === rowKey(entry)) || missing.some((e) => rowKey(e) === rowKey(entry))) continue;
      missing.push(entry);
    }
  }
  if (!missing.length) return;
  state.inventory.push(...missing);
  saveInventory();
  fetchPrices(missing);
  setStatus(t('Added {n} items you have listed on warframe.market.', { n: missing.length }));
}

function listingFor(entry) {
  const list = state.listings.get(entry.slug);
  if (!list) return null;
  const item = state.bySlug.get(entry.slug);
  return list.find((o) => (o.rank ?? null) === entry.rank && (o.subtype ?? null) === entry.subtype)
    || (isRanked(item) || item.subtypes ? null : list[0]);
}

const undercut = () => Math.max(0, Number($('#undercut').value) || 0);

function defaultPrice(lowest) {
  return lowest === null || lowest === undefined ? null : Math.max(1, lowest - undercut());
}

// label: what was being done, already translated ("Listing", "Update"…), for the error message.
async function rowAction(entry, label, fn) {
  const key = rowKey(entry);
  state.busyRows.add(key);
  render();
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) await loadAuth();
    setStatus(t('{action} failed: {error}', { action: label, error: errText(err) }));
  } finally {
    state.busyRows.delete(key);
    await loadListings(true);
  }
}

async function listEntry(entry) {
  if (!requireAuth()) return;
  if (!buildRow(entry).rankKnown) { setStatus(t('Set the rank of {name} first.', { name: itemName(state.bySlug.get(entry.slug)) })); return; }
  await ensureFreshPrices([entry]);
  const r = buildRow(entry);
  if (!r.sellAt) { setStatus(t('No price yet: type one in "Sell at".')); return; }
  if (underpriced(r) && !confirm(`${underpricedText(r)}\n\n${t('List at {price}p anyway?', { price: r.sellAt })}`)) return;
  rowAction(entry, t('Listing'), async () => {
    await Backend.createOrder({ slug: entry.slug, platinum: r.sellAt, quantity: listQtyOf(entry), rank: entry.rank, subtype: entry.subtype });
    setStatus(t('Listed {qty}× {name} at {price}p.', { qty: listQtyOf(entry), name: r.name, price: r.sellAt }));
  });
}

async function updateEntry(entry) {
  if (!requireAuth()) return;
  await ensureFreshPrices([entry]);
  const r = buildRow(entry);
  if (r.sellAt !== r.listing.platinum && underpriced(r) && !confirm(`${underpricedText(r)}\n\n${t('Change your listing to {price}p anyway?', { price: r.sellAt })}`)) return;
  rowAction(entry, t('Update'), async () => {
    await Backend.updateOrder(r.listing.id, { platinum: r.sellAt, quantity: listQtyOf(entry) });
    setStatus(t('Updated {name}: {qty}× at {price}p.', { name: r.name, qty: listQtyOf(entry), price: r.sellAt }));
  });
}

function unlistEntry(entry) {
  if (!requireAuth()) return;
  const r = buildRow(entry);
  rowAction(entry, t('Unlist'), async () => {
    await Backend.deleteOrder(r.listing.id);
    setStatus(t('Removed your listing for {name}.', { name: r.name }));
  });
}

async function soldEntry(entry, preset) {
  const r = buildRow(entry);
  let qty = preset ?? 1;
  if (preset === undefined && entry.qty > 1) {
    const answer = prompt(`${t('How many {name} did you sell?', { name: r.name })} (1–${entry.qty})`, '1');
    if (answer === null) return;
    qty = Math.round(Number(answer));
    if (!(qty >= 1)) return;
  }
  qty = Math.min(qty, entry.qty);
  const platinum = r.listing?.platinum ?? r.sellAt;

  if (r.listing && state.auth.connected && !entry.gone) {
    // Closing the order records the trade on warframe.market and lowers the listed quantity.
    await rowAction(entry, t('Marking as sold'), () => Backend.closeOrder(r.listing.id, Math.min(qty, r.listing.quantity)));
  } else if (r.listing && !entry.gone) {
    setStatus(t('Marked as sold here. Log in on warframe.market to also update the listing there.'));
  }
  recordSales([{ slug: entry.slug, name: r.item.name, qty, platinum, how: entry.gone ? HOW.goneSold : HOW.soldHere }]);
  entry.gone = null;
  removeQuantity(entry, qty);
  render();
}

// When items leave the list some other way than a sale (Baro, combining or splitting sets), a listing can't
// offer more than remain: it's lowered, or removed when none are left. Returns false if that failed.
async function fitListing(entry, left) {
  const listing = listingFor(entry);
  if (!listing || entry.gone || listing.quantity <= left) return true;
  const name = itemName(state.bySlug.get(entry.slug));
  if (!state.auth.connected) { setStatus(t('{name} is listed on warframe.market. Log in there first, so the listing can be lowered too.', { name })); return false; }
  await rowAction(entry, t('Updating the listing'), () => (left > 0
    ? Backend.updateOrder(listing.id, { quantity: left })
    : Backend.deleteOrder(listing.id)));
  return (listingFor(entry)?.quantity ?? 0) <= left; // on failure the error is in the status line
}

// Asks how many (1–max) when there's a choice; null when cancelled. question is already translated.
function askCount(question, max, preset = max) {
  if (max <= 1) return max;
  const answer = prompt(`${question} (1–${max})`, String(preset));
  if (answer === null) return null;
  const n = Math.min(max, Math.round(Number(answer)));
  return n >= 1 ? n : null;
}

// Traded to Baro Ki'Teer for ducats: the items leave the list, and a listing for them shrinks or goes too.
async function baroEntry(entry) {
  const r = buildRow(entry);
  const qty = askCount(t("How many {name} did you trade to Baro Ki'Teer?", { name: r.name }), entry.qty);
  if (qty === null || !(await fitListing(entry, entry.qty - qty))) return;
  recordSales([{ slug: entry.slug, name: r.item.name, qty, platinum: null, ducats: r.ducats, how: HOW.baro }]);
  removeQuantity(entry, qty);
  setStatus(t("Traded {qty}× {name} to Baro Ki'Teer for {ducats} ducats.", { qty, name: r.name, ducats: (r.ducats * qty).toLocaleString() }));
  render();
}

// ---------- complete sets: combine parts into a set row, or split it back ----------

// The parts leave their rows and the set gets its own, which lists, prices and sells like any other row.
// When the set sells, its parts are already gone from the list.
async function combineSet(setSlug) {
  const info = await Backend.getSet(setSlug).catch(() => null);
  const set = state.bySlug.get(setSlug);
  if (!info || !set) return;
  const partEntry = (slug) => state.inventory.find((e) => e.slug === slug);
  const max = Math.min(...info.parts.map((p) => Math.floor((partEntry(p.slug)?.qty ?? 0) / p.quantityInSet)));
  if (!(max >= 1)) return;
  const setName = itemName(set);
  const n = askCount(t('How many {name} do you want to make?', { name: setName }), max);
  if (n === null) return;
  const uses = info.parts.map((p) => ({ entry: partEntry(p.slug), qty: p.quantityInSet * n, name: state.bySlug.has(p.slug) ? itemName(state.bySlug.get(p.slug)) : p.slug }));
  const listed = uses.filter((u) => (listingFor(u.entry)?.quantity ?? 0) > u.entry.qty - u.qty);
  if (!confirm([
    t('Combine into {qty}× {name}?', { qty: n, name: setName }),
    t('Uses {parts}. The set gets its own row, ready to list. "Split" on that row undoes this.', { parts: uses.map((u) => `${u.qty}× ${u.name}`).join(', ') }),
    listed.length ? t('Listed separately right now, so those listings will be lowered or removed: {names}', { names: listed.map((u) => u.name).join(', ') }) : '',
  ].filter(Boolean).join('\n\n'))) return;
  for (const u of listed) if (!(await fitListing(u.entry, u.entry.qty - u.qty))) return;
  for (const u of uses) removeQuantity(u.entry, u.qty);
  addEntries([{ slug: setSlug, qty: n, rank: null, subtype: null }]);
  setStatus(t('Combined into {qty}× {name}.', { qty: n, name: setName }));
  computeSets();
}

async function splitSet(entry) {
  const info = await Backend.getSet(entry.slug).catch(() => null);
  if (!info) { setStatus(t('Could not load the parts of this set.')); return; }
  const name = itemName(state.bySlug.get(entry.slug));
  const n = askCount(t('How many {name} do you want to split into parts?', { name }), entry.qty, 1);
  if (n === null || !(await fitListing(entry, entry.qty - n))) return;
  removeQuantity(entry, n);
  addEntries(info.parts.map((p) => ({ slug: p.slug, qty: p.quantityInSet * n, rank: null, subtype: null })));
  setStatus(t('Split {qty}× {name} into its parts.', { qty: n, name }));
  computeSets();
}

function toggleVisible(entry) {
  if (!requireAuth()) return;
  const r = buildRow(entry);
  const visible = r.listing.visible === false;
  rowAction(entry, visible ? t('Showing') : t('Hiding'), async () => {
    await Backend.updateOrder(r.listing.id, { visible });
    setStatus(visible ? t('{name} is visible on warframe.market again.', { name: r.name }) : t('{name} is hidden: still listed, but nobody sees it.', { name: r.name }));
  });
}

// Listings whose price isn't where the default would put it: the cheapest other online seller minus your
// undercut, up or down. Rows with your own "Sell at" price keep it, and too-low prices are left alone.
function repriceTargets(rows) {
  const listed = rows.filter((r) => r.listing && !r.e.gone);
  const own = listed.filter((r) => r.e.price);
  const auto = listed.filter((r) => !r.e.price);
  return {
    own,
    alone: auto.filter((r) => r.lowestOther === null),
    cheap: auto.filter((r) => r.sellAt && underpriced(r)),
    changes: auto.filter((r) => r.sellAt && !underpriced(r) && r.sellAt !== r.listing.platinum),
  };
}

// The "Skipped…" paragraphs of a confirm message; each is [label, rows, how a row is described].
const skippedText = (groups) => groups
  .filter(([, rows]) => rows.length)
  .map(([label, rows, describe]) => `${label} (${rows.length}): ${rows.map(describe).join(', ')}`)
  .join('\n\n');

async function repriceListings() {
  if (!requireAuth()) return;
  $('#repriceBtn').disabled = true;
  try {
    await ensureFreshPrices(filteredRows().filter((r) => r.listing && !r.e.gone).map((r) => r.e));
  } finally {
    $('#repriceBtn').disabled = false;
  }
  const { own, alone, cheap, changes } = repriceTargets(filteredRows());
  const skipped = skippedText([
    [t('Kept your own "Sell at" price'), own, (r) => `${r.name} ${r.e.price}p`],
    [t('No other seller online'), alone, (r) => r.name],
    [t('Skipped, price would be too low'), cheap, (r) => t('{name} {price}p vs median {median}p', { name: r.name, price: r.sellAt, median: r.medianSell })],
  ]);
  if (!changes.length) { setStatus(t('All listings are already at their price.') + (skipped ? ' ' + skipped.replace(/\n\n/g, ' ') : '')); return; }
  if (!confirm(`${t('Change the price of {n} listings?', { n: changes.length })}\n\n`
    + changes.slice(0, 20).map((r) => `${r.name}: ${r.listing.platinum}p → ${r.sellAt}p`).join('\n')
    + (changes.length > 20 ? `\n${t('…and {n} more', { n: changes.length - 20 })}` : '')
    + (skipped ? `\n\n${skipped}` : ''))) return;
  await bulkUpdate(changes, (r) => ({ platinum: r.sellAt }), t('Repricing'), (n) => t('Repriced {n} listings.', { n }));
}

async function setAllVisible(visible) {
  if (!requireAuth()) return;
  const rows = filteredRows().filter((r) => r.listing && !r.e.gone && (r.listing.visible !== false) !== visible);
  if (!rows.length) { setStatus(visible ? t('All your listings are already visible.') : t('All your listings are already hidden.')); return; }
  await bulkUpdate(rows, () => ({ visible }), visible ? t('Showing') : t('Hiding'),
    (n) => (visible ? t('Showing {n} listings again.', { n }) : t('Hid {n} listings.', { n })));
}

// Changes listings one after another (the API allows a few requests per second), then reloads them.
async function bulkUpdate(rows, patch, verb, done) {
  const buttons = ['#repriceBtn', '#hideAllBtn', '#showAllBtn'].map($);
  buttons.forEach((b) => { b.disabled = true; });
  let ok = 0;
  const failed = [];
  try {
    for (const r of rows) {
      setStatus(t('{action} {i} of {n}: {name}', { action: verb, i: ok + failed.length + 1, n: rows.length, name: r.name }));
      try {
        await Backend.updateOrder(r.listing.id, patch(r));
        ok++;
      } catch (err) {
        failed.push(`${r.name} (${errText(err)})`);
        if (err.status === 401) { await loadAuth(); break; }
      }
    }
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
  await loadListings(true);
  setStatus(done(ok) + (failed.length ? ' ' + t('Failed: {list}', { list: failed.join('; ') }) : ''));
}

async function listAllUnlisted() {
  if (!requireAuth()) return;
  $('#listAllBtn').disabled = true;
  try {
    const candidates = filteredRows().filter((r) => !r.listing && !r.e.gone);
    await ensureFreshPrices(candidates.filter((r) => r.rankKnown).map((r) => r.e));
  } finally {
    $('#listAllBtn').disabled = false;
  }
  const unlisted = filteredRows().filter((r) => !r.listing && !r.e.gone);
  const needRank = unlisted.filter((r) => !r.rankKnown);
  const cheap = unlisted.filter((r) => r.rankKnown && underpriced(r));
  const rows = unlisted.filter((r) => r.rankKnown && r.sellAt && !underpriced(r));
  let skipped = skippedText([
    [t('Skipped, rank not set'), needRank, (r) => r.name],
    [t('Skipped, price looks too low'), cheap, (r) => t('{name} {price}p vs median {median}p', { name: r.name, price: r.sellAt, median: r.medianSell })],
  ]);
  if (cheap.length) skipped += ' ' + t('List these one by one if you mean it.');
  if (!rows.length) { setStatus(t('Nothing to list.') + (skipped ? ' ' + skipped.replace(/\n\n/g, ' ') : '')); return; }
  const total = rows.reduce((s, r) => s + r.sellAt * listQtyOf(r.e), 0);
  if (!confirm(`${t('List {n} items on warframe.market for {total}p in total?', { n: rows.length, total: total.toLocaleString() })}\n\n`
    + rows.slice(0, 15).map((r) => `${listQtyOf(r.e)}× ${r.name}: ${r.sellAt}p`).join('\n')
    + (rows.length > 15 ? `\n${t('…and {n} more', { n: rows.length - 15 })}` : '')
    + (skipped ? `\n\n${skipped}` : ''))) return;
  $('#listAllBtn').disabled = true;
  let ok = 0;
  const failed = [];
  for (const r of rows) {
    setStatus(t('{action} {i} of {n}: {name}', { action: t('Listing'), i: ok + failed.length + 1, n: rows.length, name: r.name }));
    try {
      await Backend.createOrder({ slug: r.e.slug, platinum: r.sellAt, quantity: listQtyOf(r.e), rank: r.e.rank, subtype: r.e.subtype });
      ok++;
    } catch (err) {
      failed.push(`${r.name} (${errText(err)})`);
      if (err.status === 401) { await loadAuth(); break; }
    }
  }
  $('#listAllBtn').disabled = false;
  await loadListings(true);
  setStatus(t('Listed {n} items.', { n: ok }) + (failed.length ? ' ' + t('Failed: {list}', { list: failed.join('; ') }) : ''));
}

// ---------- sales history ----------

async function loadSales() {
  state.sales = await Backend.getSales();
  renderSales();
}

function recordSales(sales) {
  const stamped = sales.map((s) => ({ ...s, at: new Date().toISOString() }));
  state.sales.push(...stamped);
  renderSales();
  Backend.addSales(stamped).catch((err) => setStatus(t('Could not save sale: {error}', { error: errText(err) })));
}

function renderSales() {
  const total = state.sales.reduce((s, x) => s + (x.platinum ?? 0) * x.qty, 0);
  const ducats = state.sales.reduce((s, x) => s + (x.platinum ? 0 : (x.ducats ?? 0) * x.qty), 0);
  $('#salesSummary').textContent = state.sales.length
    ? [t('{n} sales', { n: state.sales.length }), `${total.toLocaleString()}p`, ducats ? t('{n} ducats', { n: ducats }) : ''].filter(Boolean).join(' · ')
    : t('nothing sold yet');
  // Trades to Baro Ki'Teer earned ducats instead of platinum.
  const amount = (s, n, tag) => (s.platinum ? plat(s.platinum * n, tag)
    : s.ducats ? h(tag, { class: 'ducats', title: t('Ducats') }, t('{n} ducats', { n: s.ducats * n })) : dash());
  fill($('#salesTable tbody'), [...state.sales].reverse().map((s) => h('tr', null,
    h('td', { class: 'muted' }, new Date(s.at).toLocaleString()),
    h('td', null, state.bySlug.has(s.slug) ? itemName(state.bySlug.get(s.slug)) : s.name ?? s.slug),
    h('td', { class: 'r' }, s.qty),
    h('td', { class: 'r' }, amount(s, 1, 'span')),
    h('td', { class: 'r' }, amount(s, s.qty, 'b')),
    h('td', { class: 'muted' }, s.how ? t(s.how) : ''))));
}

// ---------- table ----------

function buildRow(e) {
  const item = state.bySlug.get(e.slug);
  const price = state.prices.get(rowKey(e));
  const listing = listingFor(e);
  const lowest = price?.lowestSell ?? null;
  // Your own listing is among the online sellers whenever you're online: price against everyone else.
  const me = state.auth.user?.slug;
  const others = price?.sellOrders?.filter((o) => !me || o.user !== me).map((o) => o.platinum);
  const lowestOther = others ? (others.length ? Math.min(...others) : null) : lowest;
  const hist = history(e);
  return {
    e, item, price, listing,
    key: rowKey(e),
    name: itemName(item),
    category: category(item),
    qty: e.qty,
    lowestSell: lowest,
    lowestOther,
    hist,
    avg7: hist?.avg ?? null,
    perDay: hist ? hist.perDay : null,
    medianSell: price?.medianSell ?? null,
    bestBuy: price?.bestBuy ?? null,
    value: lowest !== null ? lowest * e.qty : null,
    ducats: item.ducats,
    dpp: item.ducats && lowest ? item.ducats / lowest : null,
    sellAt: e.price ?? defaultPrice(lowestOther),
    listed: listing ? listing.platinum : null,
    rankKnown: e.rankKnown || !!listing,
  };
}

// A price far under what online sellers typically ask is usually a mistake, or undercutting someone's
// troll listing (a 1p offer drags "lowest online" down with it).
// Recent trades catch it too when the live price itself has been dragged down.
function underpriced(r) {
  if (!r.sellAt) return false;
  const far = (ref) => r.sellAt < ref * 0.6 && ref - r.sellAt >= 3;
  const vsOnline = r.medianSell && (r.price?.sellers ?? 0) >= 3 && far(r.medianSell);
  const vsHistory = r.avg7 && r.hist.trades >= 5 && far(r.avg7);
  return !!(vsOnline || vsHistory);
}

const underpricedText = (r) => t('{name}: {price}p is far below what it sells for (online median {median}p, cheapest {lowest}p).',
  { name: r.name, price: r.sellAt, median: r.medianSell ?? '?', lowest: r.lowestSell ?? '?' })
  + (r.avg7 ? ' ' + t('7-day average: {avg}p from {n} trades.', { avg: r.avg7, n: r.hist.trades }) : '');

// Listing uses the newest prices: anything older than a few minutes is fetched again first.
const LIST_FRESH_MS = 5 * 60 * 1000;
async function ensureFreshPrices(entries) {
  const stale = entries.filter((e) => {
    const p = state.prices.get(rowKey(e));
    return !p?.fetchedAt || Date.now() - p.fetchedAt > LIST_FRESH_MS;
  });
  if (!stale.length) return;
  setStatus(t('Checking current prices for {n} items…', { n: stale.length }));
  await fetchPrices(stale, { refetch: true, force: true });
}

function filteredRows() {
  const cat = $('#fCategory').value;
  const text = $('#fText').value.trim().toLowerCase();
  const min = Number($('#fMin').value) || 0;
  const minDpp = Number($('#fDpp').value) || 0;
  const { col, dir } = state.sort;
  return state.inventory.map(buildRow)
    .filter((r) => (!cat || r.category === cat)
      && (!text || r.name.toLowerCase().includes(text) || r.item.name.toLowerCase().includes(text))
      && (min === 0 || (r.lowestSell ?? 0) >= min)
      && (minDpp === 0 || (r.dpp ?? 0) >= minDpp))
    .sort((a, b) => {
      const x = a[col], y = b[col];
      if (x === y) return a.name.localeCompare(b.name);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
}

function rankCell(r) {
  const { e, item } = r;
  if (isRanked(item)) {
    const attrs = { class: 'num', type: 'number', min: 0, max: item.maxRank, 'data-field': 'rank' };
    if (!r.rankKnown) {
      return h('input', { ...attrs, class: 'num needs-rank', value: '', placeholder: '?',
        title: t("Rank unknown (screenshots don't show it). Enter 0–{max} before listing.", { max: item.maxRank }) });
    }
    return h('input', { ...attrs, value: e.rank, title: `0–${item.maxRank}` });
  }
  if (item.subtypes) return h('select', { 'data-field': 'subtype' }, item.subtypes.map((s) => h('option', { value: s, selected: s === e.subtype }, t(s))));
  return dash();
}

function priceCell(r, field) {
  const loading = state.loadingPrices.has(r.key);
  if (loading && !r.price?.fetchedAt) return h('span', { class: 'muted' }, '…');
  if (r.price?.error) return field === 'lowestSell' ? h('span', { class: 'bad', title: r.price.error }, t('error')) : null;
  const v = r[field];
  const stale = r.price && isStale(r.price);
  const title = r.price?.fetchedAt ? t('Fetched {ago}', { ago: ago(r.price.fetchedAt) }) : null;
  if (v === null && field === 'lowestSell' && r.price?.sellers === 0) return h('span', { class: 'muted', title: `${t('No online sellers right now.')} ${title ?? ''}` }, t('none online'));
  if (v === null) return dash();
  if (!r.rankKnown) return h('span', { class: 'plat stale', title: t('Price at rank 0. Set the rank to see the right price.') }, v);
  return h('span', { class: `plat${stale || loading ? ' stale' : ''}`, title }, v);
}

function historyCell(r, field) {
  if (!r.hist) return state.loadingStats.has(r.e.slug) ? h('span', { class: 'muted' }, '…') : dash();
  const title = t('{n} traded in the last 7 days', { n: r.hist.trades });
  if (field === 'perDay') return h('span', { title }, r.perDay >= 1 || r.perDay === 0 ? Math.round(r.perDay) : r.perDay.toFixed(1));
  if (r.avg7 === null) return h('span', { class: 'muted', title: t('No trades in the last 7 days') }, '—');
  return h('span', { class: r.rankKnown ? 'plat' : 'plat stale', title: r.rankKnown ? title : t('At rank 0. Set the rank to see the right history.') }, r.avg7);
}

function listingCell(r) {
  const { e, listing } = r;
  const busy = state.busyRows.has(r.key);
  const button = (action, label, attrs) => h('button', { class: 'small', 'data-action': action, ...attrs }, label);
  const sold = button('sold', t('Sold'), { class: 'small secondary', disabled: busy,
    title: listing && state.auth.connected ? t('Remove sold items from your list and close the order on warframe.market') : t('Remove sold items from your list') });
  const split = r.category === 'Prime Set' && button('split', t('Split'), { class: 'small secondary', title: t('Turn this set back into its parts in your list') });
  const baro = r.ducats > 0 && button('baro', t('Baro'), { class: 'small secondary',
    title: listing ? t("Traded to Baro Ki'Teer for {n} ducats each: removes them from your list and lowers the listing", { n: r.ducats })
      : t("Traded to Baro Ki'Teer for {n} ducats each: removes them from your list", { n: r.ducats }) });

  if (e.gone) {
    return h('div', { class: 'actions' },
      h('span', { class: 'bad', title: t('This listing ({qty}× at {price}p) is no longer on warframe.market', { qty: e.gone.quantity, price: e.gone.platinum }) }, t('Listing gone. Sold?')),
      button('gone-sold', t('Yes, sold')),
      button('gone-keep', t('No'), { class: 'small secondary' }));
  }
  if (busy) return h('span', { class: 'muted' }, t('working…'));

  if (!listing) {
    const title = !r.rankKnown ? t('Set the rank first') : state.auth.connected ? t('List {qty}× at {price}p', { qty: listQtyOf(e), price: r.sellAt ?? '?' }) : t('Log in on warframe.market to list');
    return h('div', { class: 'actions' }, dash(), button('list', t('List'), { disabled: !(r.sellAt && r.rankKnown), title }), sold, baro, split);
  }

  const above = r.lowestOther !== null && listing.platinum > r.lowestOther;
  const changed = (!!r.sellAt && r.sellAt !== listing.platinum) || listing.quantity !== listQtyOf(e);
  const hidden = listing.visible === false;
  return h('div', { class: 'actions' },
    h('span', { class: hidden ? 'muted' : above ? 'bad' : 'good',
      title: hidden ? t('Hidden: still listed, but nobody sees it') : above ? t('Priced above the cheapest other online seller') : t('Competitive') },
      `${listing.platinum}p ×${listing.quantity}${hidden ? ` (${t('hidden')})` : ''}`),
    state.auth.connected && changed && button('update', t('Update'), { title: t('Change listing to {qty}× at {price}p', { qty: listQtyOf(e), price: r.sellAt }) }),
    state.auth.connected && button('toggle-visible', hidden ? t('Show') : t('Hide'), { class: 'small secondary',
      title: hidden ? t('Make this listing visible on warframe.market again') : t('Keep the listing but hide it from buyers') }),
    state.auth.connected && button('unlist', t('Unlist'), { class: 'small secondary' }),
    sold, baro, split);
}

// Both item tables (not listed / listed) share these columns. Labels are translated when the header is built.
const COLUMNS = [
  { label: tk('Item'), sort: 'name' },
  { label: tk('Qty'), sort: 'qty', right: true, title: tk('How many you own') },
  { label: tk('Rank / Ref.'), right: true },
  { label: tk('Lowest sell'), sort: 'lowestSell', right: true, title: tk('Cheapest seller who is online right now') },
  { label: tk('Median'), sort: 'medianSell', right: true, title: tk('Median of the 5 cheapest online sellers') },
  { label: tk('7-day avg'), sort: 'avg7', right: true, title: tk('Average price of completed trades over the last 7 days') },
  { label: tk('Sold/day'), sort: 'perDay', right: true, title: tk('How many were traded per day over the last 7 days: how fast it sells') },
  { label: tk('Best buy'), sort: 'bestBuy', right: true, title: tk('Highest buy order from an online player — instant sale') },
  { label: tk('Value'), sort: 'value', right: true, title: tk('Lowest sell × quantity') },
  { label: tk('Ducats'), sort: 'ducats', right: true },
  { label: tk('D/P'), sort: 'dpp', right: true, title: tk("Ducats per platinum: high = better to sell to Baro Ki'Teer") },
  { label: tk('Sell at'), sort: 'sellAt', right: true, title: tk('Your listing price. Leave empty to use the default (cheapest other online seller minus undercut).') },
  { label: tk('List qty'), right: true, title: tk('How many to put on the market. Leave empty to list all you own.') },
  { label: tk('Listing'), sort: 'listed' },
  { label: '' },
];

const tableHeader = () => h('tr', null, COLUMNS.map((c) => h('th', { 'data-sort': c.sort, class: c.right ? 'r' : null, title: c.title ? t(c.title) : null }, c.label ? t(c.label) : '')));

function rowEl(r) {
  const { e, item } = r;
  const tooLow = r.rankKnown && underpriced(r);
  const cell = (child) => h('td', { class: 'r' }, child);
  return h('tr', { 'data-key': r.key, class: e.gone ? 'gone' : null },
    h('td', null, h('div', { class: 'item' },
      item.thumb ? h('img', { src: ASSETS + item.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-missing' }),
      h('a', { href: `https://warframe.market/items/${encodeURIComponent(e.slug)}`, target: '_blank', rel: 'noopener', title: r.name === item.name ? r.name : `${r.name} (${item.name})` }, r.name),
      item.vaulted && h('span', { class: 'tag' }, t('vaulted')))),
    cell(h('input', { class: 'num', type: 'number', min: 1, value: r.qty, 'data-field': 'qty' })),
    cell(rankCell(r)),
    cell(priceCell(r, 'lowestSell')),
    cell(priceCell(r, 'medianSell')),
    cell(historyCell(r, 'avg')),
    cell(historyCell(r, 'perDay')),
    cell(priceCell(r, 'bestBuy')),
    cell(r.value === null ? dash() : plat(r.value, 'b')),
    cell(fmt(r.ducats)),
    cell(r.dpp === null ? dash() : r.dpp.toFixed(1)),
    cell(h('input', { class: `num price-input${e.price ? ' custom' : ''}${tooLow ? ' too-low' : ''}`, type: 'number', min: 1, 'data-field': 'price',
      value: e.price ?? '', placeholder: defaultPrice(r.lowestOther) ?? '', title: tooLow ? underpricedText(r) : t('Empty = cheapest other online seller − undercut') })),
    cell(h('input', { class: `num${e.listQty ? ' custom' : ''}`, type: 'number', min: 1, max: r.qty, 'data-field': 'listQty',
      value: e.listQty ?? '', placeholder: r.qty, title: t('Empty = all {n}', { n: r.qty }) })),
    h('td', null, listingCell(r)),
    h('td', null, h('button', { class: 'icon', 'data-action': 'remove', title: t('Remove from list') }, '✕')));
}

// Each table is split into foldable groups by item type; empty groups are left out.
const GROUPS = [
  { key: 'prime', label: tk('Prime parts & sets'), categories: ['Prime Part', 'Prime Set'] },
  { key: 'mod', label: tk('Mods'), categories: ['Mod'] },
  { key: 'arcane', label: tk('Arcanes'), categories: ['Arcane'] },
  { key: 'relic', label: tk('Relics'), categories: ['Relic'] },
  { key: 'other', label: tk('Other'), categories: ['Other'] },
];

const foldedGroups = new Set(JSON.parse(storageGet('foldedGroups', '[]')));

function renderGroups(table, rows) {
  table.querySelectorAll('tbody').forEach((b) => b.remove());
  for (const g of GROUPS) {
    const groupRows = rows.filter((r) => g.categories.includes(r.category));
    if (!groupRows.length) continue;
    const id = `${table.id}:${g.key}`;
    const value = groupRows.reduce((s, r) => s + (r.value ?? 0), 0);
    table.append(h('tbody', { class: `group${foldedGroups.has(id) ? ' folded' : ''}`, 'data-group': id },
      h('tr', { class: 'group-head', 'data-action': 'toggle-group' }, h('td', { colspan: COLUMNS.length },
        h('span', { class: 'arrow' }),
        h('b', null, t(g.label)),
        h('span', { class: 'count' }, `${t('{n} items', { n: groupRows.length })} · ${value.toLocaleString()}p`))),
      groupRows.map(rowEl)));
  }
}

function render() {
  const rows = filteredRows();
  // Rows whose listing vanished stay with the listed ones until you confirm what happened.
  const listed = rows.filter((r) => r.listing || r.e.gone);
  const unlisted = rows.filter((r) => !r.listing && !r.e.gone);
  renderGroups($('#tableListed'), listed);
  renderGroups($('#tableUnlisted'), unlisted);
  $('[data-count=listed]').textContent = t('{n} items', { n: listed.length });
  $('[data-count=unlisted]').textContent = t('{n} items', { n: unlisted.length });
  $('#listedSection').hidden = listed.length === 0;
  $('#unlistedSection').hidden = unlisted.length === 0;

  $('#emptyMsg').hidden = state.inventory.length > 0;

  document.querySelectorAll('table.items th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.col);
    th.classList.toggle('asc', th.dataset.sort === state.sort.col && state.sort.dir === 1);
  });

  const totalPlat = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalDucats = rows.reduce((s, r) => s + (r.ducats ?? 0) * r.qty, 0);
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const listable = unlisted.filter((r) => r.sellAt && r.rankKnown && !underpriced(r)).length;
  const rankNeeded = unlisted.filter((r) => !r.rankKnown).length;
  const stat = (label, value, attrs) => h('span', attrs, `${label} `, value instanceof Node ? value : h('b', null, value));
  fill($('#summary'),
    stat(t('Rows'), rows.length),
    stat(t('Items'), totalQty),
    stat(t('Market value'), plat(`${totalPlat.toLocaleString()}p`, 'b')),
    stat(t('Ducats'), totalDucats.toLocaleString()),
    stat(t('Not listed yet'), unlisted.length),
    rankNeeded > 0 && stat(t('Rank needed'), rankNeeded, { class: 'bad', title: t("Screenshots don't show mod and arcane ranks: enter them in the Rank column before listing") }));
  $('#listAllBtn').textContent = listable ? `${t('List all unlisted')} (${listable})` : t('List all unlisted');
  const repriceable = repriceTargets(listed).changes.length;
  $('#repriceBtn').textContent = repriceable ? `${t('Reprice listings')} (${repriceable})` : t('Reprice listings');

  const gone = state.inventory.filter((e) => e.gone).length;
  $('#goneBanner').hidden = gone === 0;
  $('#goneBanner').textContent = t('{n} of your listings disappeared from warframe.market without this add-on removing them. If you sold them, click "Yes, sold" on the row to remove them from your list.', { n: gone });

  const fetched = state.inventory.map((e) => state.prices.get(rowKey(e))?.fetchedAt).filter(Boolean);
  $('#priceAge').textContent = fetched.length ? t('Oldest price: {ago}', { ago: ago(Math.min(...fetched)) }) : '';

  renderTradeMessage(rows);
}

// Trade chat is shared by players of every language, so the message uses the English item names.
function renderTradeMessage(rows) {
  const parts = rows
    .filter((r) => r.sellAt && r.rankKnown) // a rank-unknown price is the rank 0 price
    .map((r) => `[${r.item.name}]${r.e.rank ? ` r${r.e.rank}` : ''}${r.e.subtype && r.category === 'Relic' ? ` ${r.e.subtype}` : ''} ${r.sellAt}p`);
  const messages = [];
  let current = 'WTS';
  for (const p of parts) {
    if ((current + ' ' + p).length > 180 && current !== 'WTS') { messages.push(current); current = 'WTS'; }
    current += ' ' + p;
  }
  if (current !== 'WTS') messages.push(current);
  $('#tradeMsg').value = messages.join('\n');
}

// ---------- complete sets ----------

async function computeSets() {
  const owned = new Map();
  for (const e of state.inventory) {
    if (category(state.bySlug.get(e.slug)) !== 'Prime Part') continue;
    owned.set(e.slug, (owned.get(e.slug) || 0) + e.qty);
  }
  const setInfos = new Map();
  for (const slug of owned.keys()) {
    try {
      const info = await Backend.getSet(slug);
      if (info) setInfos.set(info.setSlug, info);
    } catch { /* ignore items without a set */ }
  }

  const complete = [];
  for (const info of setInfos.values()) {
    const count = Math.min(...info.parts.map((p) => Math.floor((owned.get(p.slug) || 0) / p.quantityInSet)));
    if (count >= 1) complete.push({ ...info, count });
  }

  for (const s of complete) {
    const setEntry = { slug: s.setSlug, rank: null, subtype: null };
    if (isStale(state.prices.get(rowKey(setEntry)))) await fetchPrice(setEntry);
  }

  $('#setsCard').hidden = complete.length === 0;
  fill($('#setsTable tbody'), complete.map((s) => {
    const setPrice = state.prices.get(rowKey({ slug: s.setSlug, rank: null, subtype: null }))?.lowestSell ?? null;
    const partPrices = s.parts.map((p) => (state.prices.get(rowKey({ slug: p.slug, rank: null, subtype: null }))?.lowestSell ?? null));
    const partsTotal = partPrices.includes(null) ? null : s.parts.reduce((sum, p, i) => sum + partPrices[i] * p.quantityInSet, 0);
    let better = dash();
    if (setPrice !== null && partsTotal !== null) {
      better = h('span', { class: 'good' }, setPrice >= partsTotal ? t('Set (+{n}p)', { n: setPrice - partsTotal }) : t('Parts (+{n}p)', { n: partsTotal - setPrice }));
    }
    const item = state.bySlug.get(s.setSlug);
    return h('tr', null,
      h('td', null, h('a', { href: `https://warframe.market/items/${encodeURIComponent(s.setSlug)}`, target: '_blank', rel: 'noopener' }, item ? itemName(item) : s.setSlug)),
      h('td', { class: 'r' }, s.count),
      h('td', { class: 'r' }, setPrice === null ? dash() : plat(setPrice)),
      h('td', { class: 'r' }, partsTotal === null ? dash() : plat(partsTotal)),
      h('td', { class: 'r' }, better),
      h('td', null, h('button', { class: 'small', 'data-action': 'combine', 'data-set': s.setSlug,
        title: t('Turn the parts into one set row you can list. Split undoes it.') }, t('Combine'))));
  }));
}

// ---------- backup ----------

async function exportBackup() {
  await saveChain;
  const data = await Backend.exportData();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `tenno-trade-helper-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('#backupResult').textContent = t('Saved {items} items and {sales} sales.', { items: data.inventory.length, sales: data.sales.length });
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!confirm(t('Replace what is in this browser with the contents of this file? Anything not in the file is lost.'))) return;
    await saveChain;
    const res = await Backend.importData(data);
    await reloadInventory();
    await loadSales();
    render();
    fetchPrices(state.inventory).then(computeSets);
    $('#backupResult').textContent = t('Loaded {items} items and {sales} sales.', { items: res.inventory, sales: res.sales });
  } catch (err) {
    $('#backupResult').textContent = t('Could not load that file: {error}', { error: errText(err) });
  }
}

// ---------- page language ----------

// Item names in the page language come from warframe.market (cached for a day).
async function loadNames() {
  state.names = null;
  state.byLocalName.clear();
  if (pageLangCode() !== 'en') {
    try {
      state.names = await Backend.getItemNames(pageLangCode());
      for (const [slug, name] of Object.entries(state.names)) {
        if (state.bySlug.has(slug)) state.byLocalName.set(name.toLowerCase(), state.bySlug.get(slug));
      }
    } catch { /* English names until they load */ }
  }
  fill($('#itemNames'), state.items
    .filter((i) => !i.tags.includes('set') || i.tags.includes('prime'))
    .map((i) => h('option', { value: itemName(i) })));
}

const pageLangCode = () => document.documentElement.dataset.lang || 'en';

// Everything built from code is drawn again in the new language.
function renderTexts() {
  translatePage();
  document.querySelectorAll('.item-section thead').forEach((thead) => fill(thead, tableHeader()));
  const cat = $('#fCategory').value;
  fill($('#fCategory'), h('option', { value: '' }, t('All categories')),
    Object.entries(CATEGORY_LABELS).map(([value, label]) => h('option', { value }, t(label))));
  $('#fCategory').value = cat;
  renderAccount();
  renderSales();
  render();
  computeSets();
  if (typeof renderScanTexts === 'function') renderScanTexts(); // eslint-disable-line no-undef
}

async function changePageLang(lang) {
  document.documentElement.dataset.lang = setPageLang(lang);
  storageSet('pageLang', document.documentElement.dataset.lang);
  await Backend.updateSettings({ pageLang: document.documentElement.dataset.lang });
  renderTexts();
  if (state.items.length) {
    await loadNames();
    render();
    computeSets();
  }
}

// ---------- events ----------

function wireEvents() {
  // Some items have no working picture on warframe.market; keep the row aligned with a placeholder instead.
  document.addEventListener('error', (ev) => {
    if (ev.target.tagName === 'IMG' && ev.target.closest('.item')) {
      ev.target.replaceWith(Object.assign(document.createElement('span'), { className: 'thumb-missing' }));
    }
  }, true);

  $('#addForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const item = findItem($('#addName').value);
    if (!item) { setStatus(t('No market item matches "{text}"', { text: $('#addName').value })); return; }
    addEntries([{ slug: item.slug, qty: $('#addQty').value, rank: $('#addRank').value, rankKnown: $('#addRank').value !== '' }]);
    $('#addName').value = '';
    $('#addQty').value = 1;
    $('#addRank').value = '';
    $('#addName').focus();
  });

  $('#clearBtn').addEventListener('click', () => {
    // Listed items always show, so clearing removes only what isn't listed.
    if (!confirm(t('Remove every item that is not listed on warframe.market? Listed items and your listings stay.'))) return;
    state.inventory = state.inventory.filter((e) => listingFor(e));
    saveInventory();
    render();
    computeSets();
  });

  $('#refreshBtn').addEventListener('click', refreshAll);
  $('#listAllBtn').addEventListener('click', listAllUnlisted);
  $('#repriceBtn').addEventListener('click', repriceListings);
  $('#hideAllBtn').addEventListener('click', () => setAllVisible(false));
  $('#showAllBtn').addEventListener('click', () => setAllVisible(true));

  $('#undercut').value = storageGet('undercut', '0');
  $('#undercut').addEventListener('input', () => { storageSet('undercut', $('#undercut').value); render(); });

  for (const id of ['#fCategory', '#fText', '#fMin', '#fDpp']) $(id).addEventListener('input', render);

  // Two foldable item tables with the same columns; remember which ones you folded.
  for (const section of document.querySelectorAll('.item-section')) {
    section.open = storageGet(`fold:${section.id}`, 'open') === 'open';
    section.addEventListener('toggle', () => storageSet(`fold:${section.id}`, section.open ? 'open' : 'closed'));
  }

  // Row controls in both tables (on the table: its header and groups are rebuilt).
  for (const table of document.querySelectorAll('table.items')) {
    table.querySelector('thead').addEventListener('click', (ev) => {
      const col = ev.target.closest('th[data-sort]')?.dataset.sort;
      if (!col) return;
      state.sort = state.sort.col === col ? { col, dir: -state.sort.dir } : { col, dir: col === 'name' || col === 'category' ? 1 : -1 };
      render();
    });
    table.addEventListener('click', (ev) => {
      const head = ev.target.closest('tr.group-head');
      if (!head) return;
      const id = head.closest('tbody').dataset.group;
      if (foldedGroups.has(id)) foldedGroups.delete(id); else foldedGroups.add(id);
      storageSet('foldedGroups', JSON.stringify([...foldedGroups]));
      head.closest('tbody').classList.toggle('folded', foldedGroups.has(id));
    });
    table.addEventListener('change', (ev) => {
      const field = ev.target.dataset.field;
      const entry = findEntry(ev.target.closest('tr')?.dataset.key);
      if (!field || !entry) return;
      entry[field] = field === 'subtype' ? ev.target.value : ev.target.value === '' ? null : Number(ev.target.value);
      if (field === 'rank') entry.rankKnown = ev.target.value !== '';
      Object.assign(entry, normalizeEntry(entry));
      saveInventory();
      if (field === 'rank' || field === 'subtype') fetchPrices([entry]).then(render);
      else render();
    });
    table.addEventListener('click', async (ev) => {
      const action = ev.target.dataset.action;
      const entry = findEntry(ev.target.closest('tr')?.dataset.key);
      if (!action || !entry) return;
      if (action === 'list') listEntry(entry);
      if (action === 'update') updateEntry(entry);
      if (action === 'unlist') unlistEntry(entry);
      if (action === 'sold') soldEntry(entry);
      if (action === 'baro') baroEntry(entry);
      if (action === 'split') splitSet(entry);
      if (action === 'toggle-visible') toggleVisible(entry);
      if (action === 'gone-sold') soldEntry(entry, Math.min(entry.gone.quantity, entry.qty));
      if (action === 'gone-keep') { entry.gone = null; saveInventory(); render(); }
      if (action === 'remove') {
        const listing = listingFor(entry);
        if (listing) {
          // Listed items always show in the list, so removing the row means removing the listing too.
          const name = itemName(state.bySlug.get(entry.slug));
          if (!state.auth.connected) { setStatus(t('{name} is listed on warframe.market. Log in to remove the listing first.', { name })); return; }
          if (!confirm(t('{name} is listed on warframe.market. Remove the listing and the item from your list?', { name }))) return;
          await rowAction(entry, t('Unlist'), () => Backend.deleteOrder(listing.id));
          if (listingFor(entry)) return; // unlisting failed; the error is in the status line
        }
        state.inventory = state.inventory.filter((e) => e !== entry);
        saveInventory();
        render();
      }
    });
  }

  $('#copyTrade').addEventListener('click', () => navigator.clipboard.writeText($('#tradeMsg').value));
  $('#setsTable').addEventListener('click', (ev) => { if (ev.target.dataset.action === 'combine') combineSet(ev.target.dataset.set); });

  // Account: follows the warframe.market login in this browser.
  $('#accountBtn').addEventListener('click', openLoginPage);
  $('#accessBtn').addEventListener('click', async () => {
    // No await before this call: the permission prompt only appears directly after a click.
    if (await Backend.requestAccess()) location.reload();
  });
  browser.cookies.onChanged.addListener(({ cookie }) => {
    if (cookie.name === 'JWT' && cookie.domain.endsWith('warframe.market')) onLoginMaybeChanged();
  });
  window.addEventListener('focus', onLoginMaybeChanged);

  $('#platform').addEventListener('change', async () => {
    await Backend.updateSettings({ platform: $('#platform').value });
    state.prices.clear();
    state.stats.clear();
    render();
    await loadListings(true);
    fetchPrices(state.inventory).then(computeSets);
  });

  const langSelect = $('#pageLang');
  langSelect.append(...Object.entries(PAGE_LANGS).map(([code, label]) => h('option', { value: code }, label)));
  langSelect.value = pageLangCode();
  langSelect.addEventListener('change', () => changePageLang(langSelect.value));

  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (ev) => {
    if (ev.target.files[0]) importBackup(ev.target.files[0]);
    ev.target.value = '';
  });

  // Messages from the background script. The answer goes through sendResponse: Chrome and Edge ignore a
  // returned promise.
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'focus') {
      browser.tabs.getCurrent().then((tab) => {
        browser.tabs.update(tab.id, { active: true });
        browser.windows.update(tab.windowId, { focused: true });
      });
      sendResponse(true);
    }
    if (msg?.type === 'check-orders') {
      loadListings(true);
      sendResponse(true);
    }
    return false;
  });
}

let loginCheck = null;
function onLoginMaybeChanged() {
  clearTimeout(loginCheck);
  loginCheck = setTimeout(async () => {
    if (await loadAuth()) {
      setStatus(state.auth.connected ? t('Connected as {name}.', { name: state.auth.user.ingameName }) : t('Logged out of warframe.market.'));
      await loadListings(true);
    }
  }, 500);
}

// ---------- startup ----------

async function init() {
  // The language remembered on this page first (no flash of English), then the add-on's own setting.
  document.documentElement.dataset.lang = setPageLang(storageGet('pageLang', guessLanguage()));
  state.auth = { connected: false, user: null, reason: 'checking' };
  wireEvents();
  renderTexts();
  setStatus(t('Loading item database…'));
  try {
    state.settings = await Backend.getSettings();
    $('#platform').value = state.settings.platform;
    if (state.settings.pageLang && state.settings.pageLang !== pageLangCode()) {
      document.documentElement.dataset.lang = setPageLang(state.settings.pageLang);
      $('#pageLang').value = pageLangCode();
      renderTexts();
    } else if (!state.settings.pageLang) {
      await Backend.updateSettings({ pageLang: pageLangCode() }); // so notifications use it too
    }
    await loadAuth();
    if (state.auth.reason === 'no-access') { setStatus(t('Waiting for access to warframe.market.')); return; }

    state.items = await Backend.getItems();
    for (const it of state.items) {
      state.bySlug.set(it.slug, it);
      state.byId.set(it.id, it);
      state.byName.set(it.name.toLowerCase(), it);
    }
    await loadNames();

    await reloadInventory();
    await loadCachedPrices();
    await loadCachedStats();
    setStatus(t('{n} market items loaded', { n: state.items.length.toLocaleString() }));
    render();

    await Promise.all([loadListings(), loadSales()]);
    await fetchPrices(state.inventory); // only the stale ones
    await computeSets();
  } catch (err) {
    setStatus(t('Startup failed: {error}', { error: errText(err) }));
  }
}

init();
