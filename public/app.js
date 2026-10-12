'use strict';

const ASSETS = 'https://warframe.market/static/assets/';
const ORDER_CHECK_MS = 3 * 60 * 1000; // how often to look for sales made on the website
const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  auth: { connected: false, user: null },
  items: [],
  bySlug: new Map(),
  byId: new Map(),
  byName: new Map(),
  inventory: [],        // [{ slug, qty, rank, subtype, price, gone }]
  prices: new Map(),    // rowKey -> price summary
  loadingPrices: new Set(),
  busyRows: new Set(),  // rows with a listing request in flight
  listings: new Map(),  // slug -> [your sell orders]
  sales: [],
  sort: { col: 'value', dir: -1 },
  refreshing: false,
};

// ---------- helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined ? '<span class="muted">—</span>' : n.toLocaleString());

async function api(path, method = 'GET', data) {
  const res = await fetch(path, {
    method,
    headers: data !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
  return body;
}

function category(item) {
  const t = item.tags;
  if (t.includes('prime') && t.includes('set')) return 'Prime Set';
  // Main blueprints ("Hydroid Prime Blueprint") are tagged "blueprint" rather than "component".
  if (t.includes('prime') && (t.includes('component') || t.includes('blueprint'))) return 'Prime Part';
  if (t.includes('mod')) return 'Mod';
  if (t.includes('arcane_enhancement')) return 'Arcane';
  if (t.includes('relic')) return 'Relic';
  return 'Other';
}

const isRanked = (item) => item.maxRank !== null;
const defaultSubtype = (item) => (item.subtypes ? item.subtypes[0] : null);

function normalizeEntry(e) {
  const item = state.bySlug.get(e.slug);
  const price = Number(e.price);
  return {
    slug: e.slug,
    qty: Math.max(1, Number(e.qty) || 1),
    rank: isRanked(item) ? Math.min(item.maxRank, Math.max(0, Number(e.rank) || 0)) : null,
    subtype: item.subtypes ? (item.subtypes.includes(e.subtype) ? e.subtype : defaultSubtype(item)) : null,
    price: e.price !== null && e.price !== undefined && e.price !== '' && price >= 1 ? Math.round(price) : null,
    gone: e.gone ?? null,
  };
}

const rowKey = (e) => `${e.slug}|${e.rank ?? ''}|${e.subtype ?? ''}`;
const findEntry = (key) => state.inventory.find((e) => rowKey(e) === key);

function setStatus(text) { $('#status').textContent = text; }

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function storageGet(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---------- inventory persistence ----------

// Saves run one after another so they can't arrive out of order; each sends the list as it is then.
let saveChain = Promise.resolve();
let unsaved = false;
function saveInventory() {
  unsaved = true;
  saveChain = saveChain
    .then(() => { unsaved = false; return api('/api/inventory', 'PUT', state.inventory); })
    .catch((err) => { unsaved = true; setStatus('Could not save: ' + err.message); });
}
// Last-chance save if the tab closes while a save is still pending.
window.addEventListener('pagehide', () => {
  if (unsaved) navigator.sendBeacon('/api/inventory', new Blob([JSON.stringify(state.inventory)], { type: 'application/json' }));
});

// setQty: overwrite the quantity of items already in the list instead of adding to it (used by re-scans).
function addEntries(entries, { replace = false, setQty = false } = {}) {
  if (replace) state.inventory = [];
  const added = [];
  for (const raw of entries) {
    if (!state.bySlug.has(raw.slug)) continue;
    const e = normalizeEntry(raw);
    let existing = state.inventory.find((x) => rowKey(x) === rowKey(e));
    // Rank unknown (scans): reuse the single existing row for that item.
    if (!existing && (raw.rank === null || raw.rank === undefined)) {
      const sameItem = state.inventory.filter((x) => x.slug === e.slug);
      if (sameItem.length === 1) existing = sameItem[0];
    }
    if (existing) existing.qty = setQty ? e.qty : existing.qty + e.qty;
    else { state.inventory.push(e); added.push(e); }
  }
  saveInventory();
  render();
  fetchPrices(added);
}

// Lowers an item's quantity after a sale; the row disappears when none are left.
function removeQuantity(entry, qty) {
  entry.qty -= qty;
  if (entry.qty <= 0) state.inventory = state.inventory.filter((e) => e !== entry);
  saveInventory();
}

// ---------- name lookup (for typed names) ----------

function findItem(text) {
  const q = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\bbp\b/g, 'blueprint');
  if (!q) return null;
  const exact = state.byName.get(q) || state.byName.get(q + ' blueprint') || state.bySlug.get(q.replace(/ /g, '_'));
  if (exact) return exact;
  const words = q.split(' ');
  const candidates = state.items.filter((i) => {
    const n = i.name.toLowerCase();
    return words.every((w) => n.includes(w));
  });
  if (candidates.length === 1) return candidates[0];
  const prefixed = candidates.filter((i) => i.name.toLowerCase().startsWith(q));
  if (prefixed.length === 1) return prefixed[0];
  return null;
}

// ---------- prices (cached on the server, shown instantly, refreshed when stale) ----------

const priceTtl = () => state.config.priceTtlMinutes * 60 * 1000;
const isStale = (p) => !p || p.error || Date.now() - p.fetchedAt > priceTtl();

async function loadCachedPrices() {
  for (const p of await api('/api/prices/cached')) {
    const item = state.bySlug.get(p.slug);
    if (!item) continue;
    const key = rowKey({ slug: p.slug, rank: isRanked(item) ? p.rank : null, subtype: item.subtypes ? p.subtype : null });
    state.prices.set(key, p);
  }
}

async function fetchPrice(entry, force = false) {
  const key = rowKey(entry);
  const params = new URLSearchParams({ slug: entry.slug });
  if (entry.rank !== null) params.set('rank', entry.rank);
  if (entry.subtype) params.set('subtype', entry.subtype);
  if (force) params.set('force', '1');
  state.loadingPrices.add(key);
  try {
    state.prices.set(key, await api('/api/price?' + params));
  } catch (err) {
    if (!state.prices.get(key)?.lowestSell) state.prices.set(key, { error: err.message });
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

// refetch: ask the server even for prices that aren't stale. force: the server also skips its cache.
async function fetchPrices(entries, { refetch = false, force = false } = {}) {
  const todo = entries.filter((e) => refetch || isStale(state.prices.get(rowKey(e))));
  if (!todo.length) return;
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const e = todo.shift();
      await fetchPrice(e, force);
      done++;
      setStatus(`Fetching prices… ${done} done, ${todo.length} left`);
      renderSoon();
    }
  };
  // The server serialises requests to respect the API rate limit; 3 workers keep its queue full.
  await Promise.all([worker(), worker(), worker()]);
  setStatus(`Prices updated ${new Date().toLocaleTimeString()}`);
  render();
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

// ---------- account ----------

async function loadAuth() {
  state.auth = await api('/api/auth');
  renderAccount();
}

function renderAccount() {
  const { connected, user } = state.auth;
  $('#accountText').innerHTML = connected
    ? `Connected as <b>${esc(user?.ingameName ?? user?.slug ?? '?')}</b>`
    : 'Not connected: connect to list items';
  $('#accountBtn').textContent = connected ? 'Disconnect' : 'Connect warframe.market';
  const slug = connected && user?.slug ? user.slug : state.config?.username;
  if (slug) {
    $('#profileLink').href = `https://warframe.market/profile/${slug}`;
    $('#profileLink').textContent = `warframe.market/profile/${slug}`;
  }
}

function requireAuth() {
  if (state.auth.connected) return true;
  openLogin();
  return false;
}

function openLogin() {
  $('#loginError').textContent = '';
  $('#tokenError').textContent = '';
  $('#loginPassword').value = '';
  $('#tokenInput').value = '';
  showLoginTab(storageGet('loginTab', 'token'));
  $('#loginDialog').showModal();
}

function showLoginTab(tab) {
  document.querySelectorAll('#loginDialog .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tokenForm').hidden = tab !== 'token';
  $('#loginForm').hidden = tab !== 'password';
  storageSet('loginTab', tab);
  (tab === 'token' ? $('#tokenInput') : $('#loginEmail')).focus();
}

async function connectWith(path, data, { button, error, clear }) {
  button.disabled = true;
  error.textContent = '';
  try {
    state.auth = await api(path, 'POST', data);
    clear.value = '';
    $('#loginDialog').close();
    renderAccount();
    setStatus(`Connected as ${state.auth.user?.ingameName}.`);
    await loadListings(true);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

// ---------- your listings + sale detection ----------

async function loadListings(force = false) {
  try {
    const { orders, events } = await api('/api/my-orders' + (force ? '?force=1' : ''));
    state.listings.clear();
    for (const o of orders) {
      if (o.type !== 'sell') continue;
      const item = state.byId.get(o.itemId);
      if (!item) continue;
      if (!state.listings.has(item.slug)) state.listings.set(item.slug, []);
      state.listings.get(item.slug).push(o);
    }
    if (events?.length) handleOrderEvents(events);
    render();
  } catch (err) {
    if (err.status === 401) await loadAuth();
    setStatus('Could not load your listings: ' + err.message);
  }
}

function entryForOrder(o) {
  const item = state.byId.get(o.itemId);
  if (!item) return null;
  const same = state.inventory.filter((e) => e.slug === item.slug);
  return same.find((e) => (o.rank ?? null) === e.rank && (o.subtype ?? null) === e.subtype)
    || (same.length === 1 ? same[0] : null);
}

// Changes to your orders that this app didn't make. A lower quantity is a sale marked on the website;
// a missing order is either sold or deleted, so we ask.
function handleOrderEvents(events) {
  const sold = [], gone = [];
  for (const ev of events) {
    const entry = entryForOrder(ev);
    if (!entry) continue;
    const item = state.bySlug.get(entry.slug);
    if (ev.kind === 'sold') {
      recordSales([{ slug: entry.slug, name: item.name, qty: ev.quantity, platinum: ev.platinum, how: 'marked sold on warframe.market' }]);
      removeQuantity(entry, ev.quantity);
      sold.push(`${ev.quantity}× ${item.name}`);
    } else {
      entry.gone = { quantity: ev.quantity, platinum: ev.platinum };
      gone.push(item.name);
    }
  }
  saveInventory();
  if (sold.length) setStatus(`Sold on warframe.market: ${sold.join(', ')}. Removed from your list.`);
  else if (gone.length) setStatus(`${gone.length} listing${gone.length === 1 ? '' : 's'} disappeared from warframe.market. Did they sell?`);
}

function listingFor(entry) {
  const list = state.listings.get(entry.slug);
  if (!list) return null;
  return list.find((o) => (o.rank ?? null) === entry.rank && (o.subtype ?? null) === entry.subtype)
    || (isRanked(state.bySlug.get(entry.slug)) || state.bySlug.get(entry.slug).subtypes ? null : list[0]);
}

const undercut = () => Math.max(0, Number($('#undercut').value) || 0);

function defaultPrice(lowest) {
  return lowest === null || lowest === undefined ? null : Math.max(1, lowest - undercut());
}

async function rowAction(entry, label, fn) {
  const key = rowKey(entry);
  state.busyRows.add(key);
  render();
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) await loadAuth();
    setStatus(`${label} failed: ${err.message}`);
  } finally {
    state.busyRows.delete(key);
    await loadListings(true);
  }
}

function listEntry(entry) {
  if (!requireAuth()) return;
  const r = buildRow(entry);
  if (!r.sellAt) { setStatus('No price yet: type one in "Sell at".'); return; }
  rowAction(entry, 'Listing', async () => {
    await api('/api/orders', 'POST', { slug: entry.slug, platinum: r.sellAt, quantity: entry.qty, rank: entry.rank, subtype: entry.subtype });
    setStatus(`Listed ${entry.qty}× ${r.name} at ${r.sellAt}p.`);
  });
}

function updateEntry(entry) {
  if (!requireAuth()) return;
  const r = buildRow(entry);
  rowAction(entry, 'Update', async () => {
    await api(`/api/orders/${r.listing.id}`, 'PATCH', { platinum: r.sellAt, quantity: entry.qty });
    setStatus(`Updated ${r.name}: ${entry.qty}× at ${r.sellAt}p.`);
  });
}

function unlistEntry(entry) {
  if (!requireAuth()) return;
  const r = buildRow(entry);
  rowAction(entry, 'Unlist', async () => {
    await api(`/api/orders/${r.listing.id}`, 'DELETE');
    setStatus(`Removed your listing for ${r.name}.`);
  });
}

async function soldEntry(entry, preset) {
  const r = buildRow(entry);
  let qty = preset ?? 1;
  if (preset === undefined && entry.qty > 1) {
    const answer = prompt(`How many ${r.name} did you sell? (1–${entry.qty})`, '1');
    if (answer === null) return;
    qty = Math.round(Number(answer));
    if (!(qty >= 1)) return;
  }
  qty = Math.min(qty, entry.qty);
  const platinum = r.listing?.platinum ?? r.sellAt;

  if (r.listing && state.auth.connected && !entry.gone) {
    // Closing the order records the trade on warframe.market and lowers the listed quantity.
    await rowAction(entry, 'Marking as sold', async () => {
      await api(`/api/orders/${r.listing.id}/close`, 'POST', { quantity: Math.min(qty, r.listing.quantity) });
    });
  } else if (r.listing && !entry.gone) {
    setStatus(`Marked as sold here. Connect your account to also update the listing on warframe.market.`);
  }
  recordSales([{ slug: entry.slug, name: r.name, qty, platinum, how: entry.gone ? 'confirmed after listing disappeared' : 'marked sold in this app' }]);
  entry.gone = null;
  removeQuantity(entry, qty);
  render();
}

async function listAllUnlisted() {
  if (!requireAuth()) return;
  const rows = filteredRows().filter((r) => !r.listing && r.sellAt);
  if (!rows.length) { setStatus('Nothing to list: every item shown is already listed or has no price.'); return; }
  const total = rows.reduce((s, r) => s + r.sellAt * r.qty, 0);
  if (!confirm(`List ${rows.length} items on warframe.market for ${total.toLocaleString()}p in total?\n\n`
    + rows.slice(0, 15).map((r) => `${r.qty}× ${r.name}: ${r.sellAt}p`).join('\n') + (rows.length > 15 ? `\n…and ${rows.length - 15} more` : ''))) return;
  $('#listAllBtn').disabled = true;
  let ok = 0;
  const failed = [];
  for (const r of rows) {
    setStatus(`Listing ${ok + failed.length + 1} of ${rows.length}: ${r.name}`);
    try {
      await api('/api/orders', 'POST', { slug: r.e.slug, platinum: r.sellAt, quantity: r.e.qty, rank: r.e.rank, subtype: r.e.subtype });
      ok++;
    } catch (err) {
      failed.push(`${r.name} (${err.message})`);
      if (err.status === 401) { await loadAuth(); break; }
    }
  }
  $('#listAllBtn').disabled = false;
  await loadListings(true);
  setStatus(`Listed ${ok} items.` + (failed.length ? ` Failed: ${failed.join('; ')}` : ''));
}

// ---------- sales history ----------

async function loadSales() {
  state.sales = await api('/api/sales');
  renderSales();
}

function recordSales(sales) {
  const stamped = sales.map((s) => ({ ...s, at: new Date().toISOString() }));
  state.sales.push(...stamped);
  renderSales();
  api('/api/sales', 'POST', { sales: stamped }).catch((err) => setStatus('Could not save sale: ' + err.message));
}

function renderSales() {
  const total = state.sales.reduce((s, x) => s + (x.platinum ?? 0) * x.qty, 0);
  $('#salesSummary').textContent = state.sales.length ? `${state.sales.length} sales · ${total.toLocaleString()}p` : 'nothing sold yet';
  $('#salesTable tbody').innerHTML = [...state.sales].reverse().map((s) => `<tr>
    <td class="muted">${esc(new Date(s.at).toLocaleString())}</td>
    <td>${esc(s.name ?? s.slug)}</td>
    <td class="r">${s.qty}</td>
    <td class="r">${s.platinum ? `<span class="plat">${s.platinum}</span>` : fmt(null)}</td>
    <td class="r">${s.platinum ? `<b class="plat">${s.platinum * s.qty}</b>` : fmt(null)}</td>
    <td class="muted">${esc(s.how ?? '')}</td>
  </tr>`).join('');
}

// ---------- table ----------

function buildRow(e) {
  const item = state.bySlug.get(e.slug);
  const price = state.prices.get(rowKey(e));
  const listing = listingFor(e);
  const lowest = price?.lowestSell ?? null;
  return {
    e, item, price, listing,
    key: rowKey(e),
    name: item.name,
    category: category(item),
    qty: e.qty,
    lowestSell: lowest,
    medianSell: price?.medianSell ?? null,
    bestBuy: price?.bestBuy ?? null,
    value: lowest !== null ? lowest * e.qty : null,
    ducats: item.ducats,
    dpp: item.ducats && lowest ? item.ducats / lowest : null,
    sellAt: e.price ?? defaultPrice(lowest),
    listed: listing ? listing.platinum : null,
  };
}

function filteredRows() {
  const cat = $('#fCategory').value;
  const text = $('#fText').value.trim().toLowerCase();
  const min = Number($('#fMin').value) || 0;
  const unlisted = $('#fUnlisted').checked;
  const { col, dir } = state.sort;
  return state.inventory.map(buildRow)
    .filter((r) => (!cat || r.category === cat)
      && (!text || r.name.toLowerCase().includes(text))
      && (min === 0 || (r.lowestSell ?? 0) >= min)
      && (!unlisted || !r.listing))
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
    return `<input class="num" type="number" min="0" max="${item.maxRank}" value="${e.rank}" data-field="rank" title="0–${item.maxRank}">`;
  }
  if (item.subtypes) {
    return `<select data-field="subtype">${item.subtypes.map((s) => `<option${s === e.subtype ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>`;
  }
  return '<span class="muted">—</span>';
}

function priceCell(r, field) {
  const loading = state.loadingPrices.has(r.key);
  if (loading && !r.price?.fetchedAt) return '<span class="muted">…</span>';
  if (r.price?.error) return field === 'lowestSell' ? `<span class="bad" title="${esc(r.price.error)}">error</span>` : '';
  const v = r[field];
  const stale = r.price && isStale(r.price);
  const title = r.price?.fetchedAt ? `Fetched ${ago(r.price.fetchedAt)}` : '';
  if (v === null && field === 'lowestSell' && r.price?.sellers === 0) return `<span class="muted" title="No online sellers right now. ${title}">none online</span>`;
  if (v === null) return fmt(null);
  return `<span class="plat${stale || loading ? ' stale' : ''}" title="${title}">${v}</span>`;
}

function listingCell(r) {
  const { e, listing } = r;
  const busy = state.busyRows.has(r.key);
  const sold = `<button class="small secondary" data-action="sold" title="Remove sold items from your list${listing && state.auth.connected ? ' and close the order on warframe.market' : ''}"${busy ? ' disabled' : ''}>Sold</button>`;

  if (e.gone) {
    return `<div class="actions"><span class="bad" title="This listing (${e.gone.quantity}× at ${e.gone.platinum}p) is no longer on warframe.market">Listing gone. Sold?</span>
      <button class="small" data-action="gone-sold">Yes, sold</button>
      <button class="small secondary" data-action="gone-keep">No</button></div>`;
  }
  if (busy) return '<span class="muted">working…</span>';

  if (!listing) {
    return `<div class="actions"><span class="muted">—</span>
      <button class="small" data-action="list"${r.sellAt ? '' : ' disabled'} title="${state.auth.connected ? `List ${e.qty}× at ${r.sellAt ?? '?'}p` : 'Connect your account to list'}">List</button>
      ${sold}</div>`;
  }

  const above = r.lowestSell !== null && listing.platinum > r.lowestSell;
  const changed = (r.sellAt && r.sellAt !== listing.platinum) || listing.quantity !== e.qty;
  const status = `<span class="${above ? 'bad' : 'good'}" title="${above ? 'Priced above the cheapest online seller' : 'Competitive'}">${listing.platinum}p ×${listing.quantity}${listing.visible === false ? ' (hidden)' : ''}</span>`;
  const controls = state.auth.connected
    ? `${changed ? `<button class="small" data-action="update" title="Change listing to ${e.qty}× at ${r.sellAt}p">Update</button>` : ''}
       <button class="small secondary" data-action="unlist">Unlist</button>`
    : '';
  return `<div class="actions">${status}${controls}${sold}</div>`;
}

function render() {
  const rows = filteredRows();
  const tbody = $('#table tbody');
  tbody.innerHTML = rows.map((r) => `
    <tr data-key="${esc(r.key)}"${r.e.gone ? ' class="gone"' : ''}>
      <td><div class="item">
        ${r.item.thumb ? `<img src="${ASSETS + esc(r.item.thumb)}" alt="" loading="lazy">` : ''}
        <a href="https://warframe.market/items/${esc(r.e.slug)}" target="_blank" rel="noopener">${esc(r.name)}</a>
        ${r.item.vaulted ? '<span class="tag">vaulted</span>' : ''}
      </div></td>
      <td class="muted">${r.category}</td>
      <td class="r"><input class="num" type="number" min="1" value="${r.qty}" data-field="qty"></td>
      <td class="r">${rankCell(r)}</td>
      <td class="r">${priceCell(r, 'lowestSell')}</td>
      <td class="r">${priceCell(r, 'medianSell')}</td>
      <td class="r">${priceCell(r, 'bestBuy')}</td>
      <td class="r">${r.value === null ? fmt(null) : `<b class="plat">${r.value}</b>`}</td>
      <td class="r">${fmt(r.ducats)}</td>
      <td class="r">${r.dpp === null ? fmt(null) : r.dpp.toFixed(1)}</td>
      <td class="r"><input class="num price-input${r.e.price ? ' custom' : ''}" type="number" min="1" data-field="price"
        value="${r.e.price ?? ''}" placeholder="${defaultPrice(r.lowestSell) ?? ''}" title="Empty = lowest online − undercut"></td>
      <td>${listingCell(r)}</td>
      <td><button class="icon" data-action="remove" title="Remove from list">✕</button></td>
    </tr>`).join('');

  $('#emptyMsg').hidden = state.inventory.length > 0;

  document.querySelectorAll('#table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.col);
    th.classList.toggle('asc', th.dataset.sort === state.sort.col && state.sort.dir === 1);
  });

  const totalPlat = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalDucats = rows.reduce((s, r) => s + (r.ducats ?? 0) * r.qty, 0);
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const unlisted = rows.filter((r) => !r.listing && r.sellAt).length;
  $('#summary').innerHTML = `
    <span>Rows <b>${rows.length}</b></span>
    <span>Items <b>${totalQty}</b></span>
    <span>Market value <b class="plat">${totalPlat.toLocaleString()}p</b></span>
    <span>Ducats <b>${totalDucats.toLocaleString()}</b></span>
    <span>Not listed yet <b>${unlisted}</b></span>`;
  $('#listAllBtn').textContent = unlisted ? `List all unlisted (${unlisted})` : 'List all unlisted';

  const gone = state.inventory.filter((e) => e.gone).length;
  $('#goneBanner').hidden = gone === 0;
  $('#goneBanner').textContent = `${gone} of your listings disappeared from warframe.market without this app removing them. `
    + 'If you sold them, click "Yes, sold" on the row to remove them from your list.';

  const fetched = state.inventory.map((e) => state.prices.get(rowKey(e))?.fetchedAt).filter(Boolean);
  $('#priceAge').textContent = fetched.length ? `Oldest price: ${ago(Math.min(...fetched))}` : '';

  renderTradeMessage(rows);
}

function renderTradeMessage(rows) {
  const parts = rows
    .filter((r) => r.sellAt)
    .map((r) => `[${r.name}]${r.e.rank ? ` r${r.e.rank}` : ''}${r.e.subtype && r.category === 'Relic' ? ` ${r.e.subtype}` : ''} ${r.sellAt}p`);
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
      const info = await api('/api/set?slug=' + encodeURIComponent(slug));
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
  $('#setsTable tbody').innerHTML = complete.map((s) => {
    const setPrice = state.prices.get(rowKey({ slug: s.setSlug, rank: null, subtype: null }))?.lowestSell ?? null;
    const partPrices = s.parts.map((p) => (state.prices.get(rowKey({ slug: p.slug, rank: null, subtype: null }))?.lowestSell ?? null));
    const partsTotal = partPrices.includes(null) ? null : s.parts.reduce((sum, p, i) => sum + partPrices[i] * p.quantityInSet, 0);
    let better = '<span class="muted">—</span>';
    if (setPrice !== null && partsTotal !== null) {
      better = setPrice >= partsTotal
        ? `<span class="good">Set (+${setPrice - partsTotal}p)</span>`
        : `<span class="good">Parts (+${partsTotal - setPrice}p)</span>`;
    }
    const item = state.bySlug.get(s.setSlug);
    return `<tr>
      <td><a href="https://warframe.market/items/${esc(s.setSlug)}" target="_blank" rel="noopener">${esc(item ? item.name : s.setSlug)}</a></td>
      <td class="r">${s.count}</td>
      <td class="r">${setPrice === null ? fmt(null) : `<span class="plat">${setPrice}</span>`}</td>
      <td class="r">${partsTotal === null ? fmt(null) : `<span class="plat">${partsTotal}</span>`}</td>
      <td class="r">${better}</td>
    </tr>`;
  }).join('');
}

// ---------- events ----------

function wireEvents() {
  $('#addForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const item = findItem($('#addName').value);
    if (!item) { setStatus(`No market item matches "${$('#addName').value}"`); return; }
    addEntries([{ slug: item.slug, qty: $('#addQty').value, rank: $('#addRank').value }]);
    $('#addName').value = '';
    $('#addQty').value = 1;
    $('#addRank').value = '';
    $('#addName').focus();
  });

  $('#clearBtn').addEventListener('click', () => {
    if (!confirm('Remove every item from the list? Your warframe.market listings are not touched.')) return;
    state.inventory = [];
    saveInventory();
    render();
    $('#setsCard').hidden = true;
  });

  $('#refreshBtn').addEventListener('click', refreshAll);
  $('#listAllBtn').addEventListener('click', listAllUnlisted);

  $('#undercut').value = storageGet('undercut', '0');
  $('#undercut').addEventListener('input', () => { storageSet('undercut', $('#undercut').value); render(); });

  for (const id of ['#fCategory', '#fText', '#fMin', '#fUnlisted']) $(id).addEventListener('input', render);

  document.querySelectorAll('#table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const col = th.dataset.sort;
    state.sort = state.sort.col === col ? { col, dir: -state.sort.dir } : { col, dir: col === 'name' || col === 'category' ? 1 : -1 };
    render();
  }));

  const tbody = $('#table tbody');
  tbody.addEventListener('change', (ev) => {
    const field = ev.target.dataset.field;
    const entry = findEntry(ev.target.closest('tr')?.dataset.key);
    if (!field || !entry) return;
    entry[field] = field === 'subtype' ? ev.target.value : ev.target.value === '' ? null : Number(ev.target.value);
    Object.assign(entry, normalizeEntry(entry));
    saveInventory();
    if (field === 'rank' || field === 'subtype') fetchPrices([entry]).then(render);
    else render();
  });
  tbody.addEventListener('click', async (ev) => {
    const action = ev.target.dataset.action;
    const entry = findEntry(ev.target.closest('tr')?.dataset.key);
    if (!action || !entry) return;
    if (action === 'list') listEntry(entry);
    if (action === 'update') updateEntry(entry);
    if (action === 'unlist') unlistEntry(entry);
    if (action === 'sold') soldEntry(entry);
    if (action === 'gone-sold') soldEntry(entry, Math.min(entry.gone.quantity, entry.qty));
    if (action === 'gone-keep') { entry.gone = null; saveInventory(); render(); }
    if (action === 'remove') {
      const listing = listingFor(entry);
      if (listing && state.auth.connected && confirm(`Also remove your warframe.market listing for ${state.bySlug.get(entry.slug).name}?`)) {
        await rowAction(entry, 'Unlist', () => api(`/api/orders/${listing.id}`, 'DELETE'));
      }
      state.inventory = state.inventory.filter((e) => e !== entry);
      saveInventory();
      render();
    }
  });

  $('#copyTrade').addEventListener('click', () => navigator.clipboard.writeText($('#tradeMsg').value));

  // Account
  $('#accountBtn').addEventListener('click', async () => {
    if (!state.auth.connected) { openLogin(); return; }
    if (!confirm('Disconnect your warframe.market account from this app?')) return;
    state.auth = await api('/api/auth/logout', 'POST');
    renderAccount();
    await loadListings(true);
  });
  document.querySelectorAll('#loginDialog [data-action=close-login]').forEach((b) => b.addEventListener('click', () => $('#loginDialog').close()));
  document.querySelectorAll('#loginDialog .tab').forEach((b) => b.addEventListener('click', () => showLoginTab(b.dataset.tab)));
  $('#tokenForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    connectWith('/api/auth/token', { token: $('#tokenInput').value },
      { button: $('#tokenSubmit'), error: $('#tokenError'), clear: $('#tokenInput') });
  });
  $('#loginForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    connectWith('/api/auth/login', { email: $('#loginEmail').value, password: $('#loginPassword').value },
      { button: $('#loginSubmit'), error: $('#loginError'), clear: $('#loginPassword') });
  });
}

// ---------- startup ----------

async function init() {
  wireEvents();
  try {
    state.config = await api('/api/config');
    renderAccount();

    state.items = await api('/api/items');
    for (const it of state.items) {
      state.bySlug.set(it.slug, it);
      state.byId.set(it.id, it);
      state.byName.set(it.name.toLowerCase(), it);
    }
    $('#itemNames').innerHTML = state.items
      .filter((i) => !i.tags.includes('set') || i.tags.includes('prime'))
      .map((i) => `<option value="${esc(i.name)}">`).join('');
    for (const c of ['Prime Part', 'Prime Set', 'Mod', 'Arcane', 'Relic', 'Other']) {
      $('#fCategory').insertAdjacentHTML('beforeend', `<option>${c}</option>`);
    }

    state.inventory = (await api('/api/inventory')).filter((e) => state.bySlug.has(e.slug)).map(normalizeEntry);
    await loadCachedPrices();
    setStatus(`${state.items.length.toLocaleString()} market items loaded`);
    render();

    await loadAuth();
    await Promise.all([loadListings(), loadSales()]);
    await fetchPrices(state.inventory); // only the stale ones
    await computeSets();
    setInterval(() => loadListings(true), ORDER_CHECK_MS);
  } catch (err) {
    setStatus('Startup failed: ' + err.message);
  }
}

init();
