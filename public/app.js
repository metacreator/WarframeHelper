'use strict';

const ASSETS = 'https://warframe.market/static/assets/';
const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  items: [],
  bySlug: new Map(),
  byId: new Map(),
  byName: new Map(),
  inventory: [],        // [{ slug, qty, rank, subtype }]
  prices: new Map(),    // rowKey -> price summary
  loadingPrices: new Set(),
  listings: new Map(),  // slug -> [sell orders]
  sort: { col: 'value', dir: -1 },
  refreshing: false,
};

// ---------- helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined ? '<span class="muted">—</span>' : n.toLocaleString());

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function category(item) {
  const t = item.tags;
  if (t.includes('prime') && t.includes('set')) return 'Prime Set';
  if (t.includes('prime') && t.includes('component')) return 'Prime Part';
  if (t.includes('mod')) return 'Mod';
  if (t.includes('arcane_enhancement')) return 'Arcane';
  if (t.includes('relic')) return 'Relic';
  return 'Other';
}

const isRanked = (item) => item.maxRank !== null;
const defaultSubtype = (item) => (item.subtypes ? item.subtypes[0] : null);

function normalizeEntry(e) {
  const item = state.bySlug.get(e.slug);
  return {
    slug: e.slug,
    qty: Math.max(1, Number(e.qty) || 1),
    rank: isRanked(item) ? Math.min(item.maxRank, Math.max(0, Number(e.rank) || 0)) : null,
    subtype: item.subtypes ? (item.subtypes.includes(e.subtype) ? e.subtype : defaultSubtype(item)) : null,
  };
}

const rowKey = (e) => `${e.slug}|${e.rank ?? ''}|${e.subtype ?? ''}`;

function setStatus(text) { $('#status').textContent = text; }

// ---------- inventory persistence ----------

let saveTimer = null;
function saveInventory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api('/api/inventory', { method: 'PUT', body: JSON.stringify(state.inventory) })
      .catch((err) => setStatus('Could not save: ' + err.message));
  }, 400);
}

// setQty: overwrite the quantity of items already in the list instead of adding to it (used by re-scans).
function addEntries(entries, { replace = false, setQty = false } = {}) {
  if (replace) state.inventory = [];
  const added = [];
  for (const raw of entries) {
    if (!state.bySlug.has(raw.slug)) continue;
    const e = normalizeEntry(raw);
    let existing = state.inventory.find((x) => rowKey(x) === rowKey(e));
    // Rank unknown (scans, pasted lines without "r10"): reuse the single existing row for that item.
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

// ---------- name lookup (for typed / pasted names) ----------

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

const SUBTYPE_WORDS = ['intact', 'exceptional', 'flawless', 'radiant'];

function parseLine(line) {
  let text = ' ' + line.replace(/\t/g, ' ') + ' ';
  let qty = 1, rank = null, subtype = null, m;
  if ((m = text.match(/\s(?:r|rank\s*)(\d{1,2})\s/i))) { rank = Number(m[1]); text = text.replace(m[0], ' '); }
  if ((m = text.match(/\s(?:x\s*(\d+)|(\d+)\s*x)\s/i))) { qty = Number(m[1] || m[2]); text = text.replace(m[0], ' '); }
  else if ((m = text.match(/[,:;]\s*(\d+)\s*$/))) { qty = Number(m[1]); text = text.replace(m[0], ' '); }
  for (const w of SUBTYPE_WORDS) {
    const re = new RegExp(`\\s${w}\\s`, 'i');
    if (re.test(text)) { subtype = w; text = text.replace(re, ' '); }
  }
  return { name: text.trim(), qty, rank, subtype };
}

// ---------- prices ----------

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
    state.prices.set(key, { error: err.message });
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

async function fetchPrices(entries, { refetch = false, force = false } = {}) {
  const todo = entries.filter((e) => refetch || !state.prices.has(rowKey(e)));
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
  setStatus(`Prices updated ${new Date().toLocaleTimeString()} · cached ${state.config.priceTtlMinutes} min`);
  render();
}

async function refreshAll() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('#refreshBtn').disabled = true;
  try {
    // Re-request every row; the server answers from its cache unless "ignore cache" is ticked.
    const force = $('#forceRefresh').checked;
    await loadListings(force);
    await fetchPrices(state.inventory, { refetch: true, force });
    await computeSets();
  } finally {
    state.refreshing = false;
    $('#refreshBtn').disabled = false;
  }
}

// ---------- my listings ----------

async function loadListings(force = false) {
  try {
    const { orders } = await api('/api/my-orders' + (force ? '?force=1' : ''));
    state.listings.clear();
    for (const o of orders) {
      if (o.type !== 'sell') continue;
      const item = state.byId.get(o.itemId);
      if (!item) continue;
      if (!state.listings.has(item.slug)) state.listings.set(item.slug, []);
      state.listings.get(item.slug).push(o);
    }
    render();
    return orders;
  } catch (err) {
    setStatus('Could not load your listings: ' + err.message);
    return [];
  }
}

function listingFor(entry) {
  const list = state.listings.get(entry.slug);
  if (!list) return null;
  return list.find((o) => (o.rank ?? null) === entry.rank && (o.subtype ?? null) === entry.subtype) || list[0];
}

// ---------- table ----------

function buildRows() {
  return state.inventory.map((e) => {
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
      listed: listing ? listing.platinum : null,
    };
  });
}

function filteredRows() {
  const cat = $('#fCategory').value;
  const text = $('#fText').value.trim().toLowerCase();
  const min = Number($('#fMin').value) || 0;
  const unlisted = $('#fUnlisted').checked;
  const { col, dir } = state.sort;
  return buildRows()
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
  if (state.loadingPrices.has(r.key)) return '<span class="muted">…</span>';
  if (r.price?.error) return field === 'lowestSell' ? `<span class="bad" title="${esc(r.price.error)}">error</span>` : '';
  const v = r[field];
  if (v === null && field === 'lowestSell' && r.price?.sellers === 0) return '<span class="muted" title="No online sellers right now">none online</span>';
  return v === null ? fmt(null) : `<span class="plat">${v}</span>`;
}

function listedCell(r) {
  if (!r.listing) return '<span class="muted">—</span>';
  const p = r.listing.platinum;
  let cls = '';
  if (r.lowestSell !== null) cls = p > r.lowestSell ? 'bad' : 'good';
  const title = r.lowestSell !== null && p > r.lowestSell ? 'Priced above the cheapest online seller' : 'Competitive';
  return `<span class="${cls}" title="${title}">${p}p ×${r.listing.quantity}${r.listing.visible === false ? ' (hidden)' : ''}</span>`;
}

function render() {
  const rows = filteredRows();
  const tbody = $('#table tbody');
  tbody.innerHTML = rows.map((r) => `
    <tr data-key="${esc(r.key)}">
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
      <td class="r">${listedCell(r)}</td>
      <td><button class="icon" data-action="remove" title="Remove">✕</button></td>
    </tr>`).join('');

  $('#emptyMsg').hidden = state.inventory.length > 0;

  document.querySelectorAll('#table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.col);
    th.classList.toggle('asc', th.dataset.sort === state.sort.col && state.sort.dir === 1);
  });

  const totalPlat = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalDucats = rows.reduce((s, r) => s + (r.ducats ?? 0) * r.qty, 0);
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const unlisted = rows.filter((r) => !r.listing && r.lowestSell !== null).length;
  $('#summary').innerHTML = `
    <span>Rows <b>${rows.length}</b></span>
    <span>Items <b>${totalQty}</b></span>
    <span>Market value <b class="plat">${totalPlat.toLocaleString()}p</b></span>
    <span>Ducats <b>${totalDucats.toLocaleString()}</b></span>
    <span>Not listed yet <b>${unlisted}</b></span>`;

  renderTradeMessage(rows);
}

function renderTradeMessage(rows) {
  const parts = rows
    .filter((r) => r.lowestSell !== null)
    .map((r) => `[${r.name}]${r.e.rank ? ` r${r.e.rank}` : ''}${r.e.subtype && r.category === 'Relic' ? ` ${r.e.subtype}` : ''} ${r.lowestSell}p`);
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
    if (!state.prices.has(rowKey(setEntry))) await fetchPrice(setEntry);
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

  $('#pasteBtn').addEventListener('click', () => {
    const lines = $('#pasteBox').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const entries = [], missed = [];
    for (const line of lines) {
      const p = parseLine(line);
      const item = findItem(p.name);
      if (item) entries.push({ slug: item.slug, qty: p.qty, rank: p.rank, subtype: p.subtype });
      else missed.push(line);
    }
    addEntries(entries);
    $('#pasteResult').textContent = `Added ${entries.length}.` + (missed.length ? ` Not recognised: ${missed.join(' · ')}` : '');
    $('#pasteBox').value = missed.join('\n');
  });

  $('#importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    $('#importResult').textContent = 'Importing…';
    try {
      const res = await api('/api/import', { method: 'POST', body: await file.text() });
      addEntries(res.items, { replace: $('#importReplace').checked });
      $('#importResult').textContent = `Matched ${res.items.length} tradable items out of ${res.scanned} inventory entries.`;
    } catch (err) {
      $('#importResult').textContent = 'Import failed: ' + err.message;
    }
    ev.target.value = '';
  });

  $('#importOrdersBtn').addEventListener('click', async () => {
    const orders = await loadListings(true);
    const entries = orders
      .filter((o) => o.type === 'sell' && state.byId.has(o.itemId))
      .map((o) => ({ slug: state.byId.get(o.itemId).slug, qty: o.quantity, rank: o.rank, subtype: o.subtype }))
      .filter((e) => !state.inventory.some((x) => rowKey(x) === rowKey(normalizeEntry(e))));
    addEntries(entries);
    setStatus(`Added ${entries.length} items from your listings.`);
  });

  $('#clearBtn').addEventListener('click', () => {
    if (!confirm('Remove every item from the list?')) return;
    state.inventory = [];
    saveInventory();
    render();
    $('#setsCard').hidden = true;
  });

  $('#refreshBtn').addEventListener('click', refreshAll);

  for (const id of ['#fCategory', '#fText', '#fMin', '#fUnlisted']) $(id).addEventListener('input', render);

  document.querySelectorAll('#table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const col = th.dataset.sort;
    state.sort = state.sort.col === col ? { col, dir: -state.sort.dir } : { col, dir: col === 'name' || col === 'category' ? 1 : -1 };
    render();
  }));

  const tbody = $('#table tbody');
  tbody.addEventListener('change', (ev) => {
    const field = ev.target.dataset.field;
    const key = ev.target.closest('tr')?.dataset.key;
    const entry = state.inventory.find((e) => rowKey(e) === key);
    if (!field || !entry) return;
    entry[field] = field === 'subtype' ? ev.target.value : Number(ev.target.value);
    Object.assign(entry, normalizeEntry(entry));
    saveInventory();
    if (field === 'qty') render();
    else fetchPrices([entry]).then(render);
  });
  tbody.addEventListener('click', (ev) => {
    if (ev.target.dataset.action !== 'remove') return;
    const key = ev.target.closest('tr').dataset.key;
    state.inventory = state.inventory.filter((e) => rowKey(e) !== key);
    saveInventory();
    render();
  });

  $('#copyTrade').addEventListener('click', () => navigator.clipboard.writeText($('#tradeMsg').value));
}

// ---------- startup ----------

async function init() {
  wireEvents();
  try {
    state.config = await api('/api/config');
    const profile = `https://warframe.market/profile/${state.config.username}`;
    $('#profileLink').href = profile;
    $('#profileLink').textContent = `warframe.market/profile/${state.config.username}`;

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
    setStatus(`${state.items.length.toLocaleString()} market items loaded`);
    render();
    await loadListings();
    await fetchPrices(state.inventory);
    await computeSets();
  } catch (err) {
    setStatus('Startup failed: ' + err.message);
  }
}

init();
