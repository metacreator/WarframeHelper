'use strict';
/* global browser, state, scan, addShots, rowKey, loadListings, importBackup, Backend, renderPreview, POOL_SIZE, addEntries, buildRow, underpriced, listEntry, listAllUnlisted, render, repriceListings, aggregate, history, computeSets, LOCALES, openDialog, t */
// TEST BUILD ONLY: drives app.html from inside the add-on (WebDriver can't script extension pages)
// and reports results to the mock server. The runner sets/clears the warframe.market cookie when asked.
(async () => {
  if (!location.search.includes('selftest')) return;
  const MOCK = 'http://127.0.0.1:3901';
  const post = (path, data) => fetch(MOCK + path, { method: 'POST', body: JSON.stringify(data) });
  const report = (label, ok, extra = '') => post('/_report', { label, ok: !!ok, extra: String(extra) });
  const phase = (name) => fetch(`${MOCK}/_phase?name=${name}`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await fn()) return true; } catch { /* not ready */ }
      await sleep(250);
    }
    throw new Error('timed out: ' + label);
  }
  const inv = () => state.inventory.map((e) => `${e.slug}:${e.qty}${e.gone ? ':GONE' : ''}`).join(' ');
  const mockJson = async (p) => (await fetch(MOCK + p)).json();
  const click = (sel) => document.querySelector(sel).click();
  let confirmAnswer = true, lastConfirm = '';
  // The page asks through its own dialogs; answer them here.
  window.uiConfirm = async (msg) => { lastConfirm = msg; return confirmAnswer; };
  let promptAnswer = '1';
  window.uiPrompt = async () => promptAnswer;
  async function capture(name) {
    try { await browser.tabs.update((await browser.tabs.getCurrent()).id, { active: true }); await post('/_shot', { name, data: await browser.tabs.captureVisibleTab() }); } catch (e) { await report('screenshot ' + name, false, e.message); }
  }

  try {
    await until(() => state.settings && (state.auth.reason === 'no-access' || state.items.length > 0), 40000, 'init');
    if (state.auth.reason === 'no-access') {
      await report('host permissions granted at install', false, 'banner shown; requesting');
      return;
    }
    await report('host permissions granted at install', true);
    await report('items loaded in add-on', state.items.length > 3000, state.items.length);
    await sleep(600); await capture('welcome');
    await report('not connected before login', !state.auth.connected, state.auth.reason);

    await phase('need-cookie');
    await until(() => state.auth.connected, 30000, 'auto-connect');
    await report('connected automatically from site login', true, document.getElementById('accountText').textContent);

    // A listing made on the website (item not in the list) shows up under "Listed"
    const akId = state.bySlug.get('akstiletto_prime_blueprint').id;
    await fetch(`${MOCK}/_list-on-site?itemId=${akId}&qty=2&platinum=15`);
    await loadListings(true);
    await until(() => document.querySelector('#tableListed tr[data-key^="akstiletto_prime_blueprint|"]'), 10000, 'listed-only item row');
    await report('listing made on the website appears under "Listed"', state.inventory.find((e) => e.slug === 'akstiletto_prime_blueprint')?.qty === 2
      && !document.getElementById('listedSection').hidden, document.getElementById('status').textContent);
    await loadListings(true);
    await report('not added twice on the next check', state.inventory.filter((e) => e.slug === 'akstiletto_prime_blueprint').length === 1);
    // ✕ on a listed row removes the listing and the row (confirm answers yes)
    document.querySelector('#tableListed tr[data-key^="akstiletto_prime_blueprint|"] [data-action=remove]').click();
    await until(() => !state.inventory.some((e) => e.slug === 'akstiletto_prime_blueprint'), 15000, 'remove listed row');
    await report('removing a listed row also removes the listing', (await mockJson('/_orders')).length === 0);

    // Add by hand
    document.getElementById('addName').value = 'Kogake Prime Boot';
    document.getElementById('addQty').value = '2';
    document.getElementById('addForm').requestSubmit();
    await until(() => state.inventory.length === 1 && state.prices.get(rowKey(state.inventory[0]))?.fetchedAt, 30000, 'price');
    await report('added by hand and priced', true, `${inv()} @ ${state.prices.get(rowKey(state.inventory[0])).lowestSell}p`);

    // List only 1 of the 2 via "List qty"
    await report('new item starts in "Not listed yet"', !!document.querySelector('#tableUnlisted tr[data-key^="kogake_prime_boot|"]') && document.getElementById('listedSection').hidden);
    const listQty = document.querySelector('#tableUnlisted tr[data-key^="kogake_prime_boot|"] [data-field=listQty]');
    listQty.value = '1';
    listQty.dispatchEvent(new Event('change', { bubbles: true }));
    click('#tableUnlisted [data-action=list]');
    await until(() => state.listings.has('kogake_prime_boot'), 15000, 'listing');
    let orders = await mockJson('/_orders');
    await report('"List qty" lists only that many', orders.length === 1 && orders[0].quantity === 1, JSON.stringify(orders));
    await report('row moved to "Listed on warframe.market"', !!document.querySelector('#tableListed tr[data-key^="kogake_prime_boot|"]')
      && !document.querySelector('#tableUnlisted tr[data-key^="kogake_prime_boot|"]') && document.getElementById('unlistedSection').hidden);

    // Clear "List qty" (= all 2) -> Update raises the listing to 2
    const listQty2 = document.querySelector('#tableListed tr[data-key^="kogake_prime_boot|"] [data-field=listQty]');
    listQty2.value = '';
    listQty2.dispatchEvent(new Event('change', { bubbles: true }));
    click('#tableListed [data-action=update]');
    await until(() => state.listings.get('kogake_prime_boot')?.[0].quantity === 2, 15000, 'update');
    orders = await mockJson('/_orders');
    document.querySelector('#scanCard').hidden = true; window.scrollTo(0, 0); await sleep(300); await capture('sections'); document.querySelector('#scanCard').hidden = false;
    await report('Update applies the new quantity', orders[0].quantity === 2, JSON.stringify(orders));

    // Folding a section is remembered
    document.getElementById('listedSection').open = false;
    await sleep(100);
    await report('folded section remembered', localStorage.getItem('fold:listedSection') === 'closed');
    document.getElementById('listedSection').open = true;

    // Scan with bundled Tesseract
    const files = [];
    for (const n of ['shotA.png', 'shotB.png']) files.push(new File([await (await fetch(`${MOCK}/${n}`)).blob()], n, { type: 'image/png' }));
    const t0 = Date.now();
    let parallel = 0;
    addShots(files);
    await until(() => {
      parallel = Math.max(parallel, scan.busy.filter(Boolean).length);
      return scan.shots.length === 2 && scan.shots.every((s) => s.status === 'done' || s.status === 'error');
    }, 150000, 'scan');
    const errors = scan.shots.filter((s) => s.error).map((s) => s.error);
    const matched = scan.rows.filter((r) => r.item).length;
    await report('scan works with bundled Tesseract (18 matched)', matched === 18 && !errors.length,
      `${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${matched}, counts ${scan.rows.filter((r) => r.qty > 1).map((r) => r.item?.slug + '×' + r.qty).join(' ')} ${errors.join(';')}`);
    await report('two screenshots are read at the same time', POOL_SIZE < 2 || parallel === 2,
      `${POOL_SIZE} workers; ${scan.shots.map((s) => `${s.name} ${s.seconds.toFixed(1)}s ${JSON.stringify(s.timings)}`).join(' | ')}`);
    await capture('scan');
    click('#scanAdd');
    await until(() => state.inventory.length === 19, 10000, 'scan rows added');
    await report('scan results added to the list', true, `${state.inventory.length} rows`);

    // Type groups: prime parts, mods, arcanes and relics each get their own foldable group
    const groups = [...document.querySelectorAll('#tableUnlisted tbody.group')].map((b) => `${b.dataset.group.split(':')[1]}=${b.querySelectorAll('tr[data-key]').length}`);
    await report('items split into type groups', groups.join(' ') === 'prime=12 mod=4 arcane=1 relic=1', groups.join(' '));

    // Rank safety: scanned mods have an unknown rank and can't be listed until it is entered
    const serrationRow = () => document.querySelector('#tableUnlisted tr[data-key^="serration|"]');
    await report('scanned mod needs its rank before listing', serrationRow().querySelector('[data-action=list]').disabled
      && serrationRow().querySelector('[data-field=rank]').classList.contains('needs-rank')
      && /Rank needed\s*5/.test(document.getElementById('summary').textContent), document.getElementById('summary').textContent.replace(/\s+/g, ' '));
    const rankInput = serrationRow().querySelector('[data-field=rank]');
    rankInput.value = '10';
    rankInput.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => { const e = state.inventory.find((x) => x.slug === 'serration'); return e?.rankKnown && state.prices.get(rowKey(e))?.fetchedAt; }, 30000, 'rank set + rank 10 price');
    await report('entering the rank unlocks listing', !serrationRow().querySelector('[data-action=list]').disabled && state.inventory.find((e) => e.slug === 'serration').rank === 10);
    document.querySelector('#tableUnlisted tbody[data-group$=":mod"] tr.group-head td').click();
    await sleep(100);
    const modRow = document.querySelector('#tableUnlisted tbody[data-group$=":mod"] tr[data-key]');
    await report('folding a group hides its rows and is remembered', getComputedStyle(modRow).display === 'none' && localStorage.getItem('foldedGroups').includes(':mod'));
    document.querySelector('#tableUnlisted tbody[data-group$=":mod"] tr.group-head td').click();
    document.querySelector('#scanCard').hidden = true; document.getElementById('unlistedSection').scrollIntoView(); await sleep(300); await capture('groups'); document.querySelector('#scanCard').hidden = false;
    await report('header links to warframe.market, not a profile', document.querySelector('header .sub a').href === 'https://warframe.market/'
      && document.querySelector('#accountText a')?.href.includes('/profile/mocktenno'));

    // Real in-game screenshots: 24 items each, no visible counts (all 1), several names drawn over bright art
    const realCases = { 'real1.png': ['ivara_prime_systems_blueprint', 'fragor_prime_handle', 'galatine_prime_handle', 'kestrel_prime_blade'],
      'real2.png': ['epitaph_prime_barrel', 'gram_prime_blade', 'bronco_prime_barrel', 'akbronco_prime_link'] };
    for (const [file, want] of Object.entries(realCases)) {
      click('#scanClear');
      addShots([new File([await (await fetch(MOCK + '/' + file)).blob()], file, { type: 'image/png' })]);
      await until(() => scan.shots.length === 1 && scan.shots[0].status === 'done', 150000, 'real scan ' + file);
      const realRows = scan.rows.filter((r) => r.item && !r.ambiguous);
      const wrongQty = realRows.filter((r) => r.qty !== 1).map((r) => r.item.slug + '×' + r.qty);
      const missing = want.filter((w) => !realRows.some((r) => r.item.slug === w));
      await report(`real screenshot ${file}: 24 items, all ×1`, realRows.length === 24 && !wrongQty.length && !missing.length,
        `${realRows.length} items, wrong qty: ${wrongQty.join(' ') || 'none'}, missing: ${missing.join(' ') || 'none'}, ${scan.shots[0].seconds.toFixed(1)}s ${JSON.stringify(scan.shots[0].timings)}`);
    }
    click('#scanClear');

    // Other game languages: names as warframe.market writes them in that language, stack counts, and a
    // Radiant relic next to an Intact one. English goes last; its result is added to the list further down.
    const langSpec = await mockJson('/language-shots.json');
    const langSelect = document.getElementById('scanLang');
    for (const lang of ['uk', 'es', 'zh-hans', 'zh-hant', 'en']) {
      click('#scanClear');
      langSelect.value = lang;
      langSelect.dispatchEvent(new Event('change'));
      const file = `lang-${lang}.png`;
      addShots([new File([await (await fetch(`${MOCK}/${file}`)).blob()], file, { type: 'image/png' })]);
      await until(() => scan.shots.length === 1 && ['done', 'error'].includes(scan.shots[0].status), 150000, 'language scan ' + lang);
      const want = langSpec[lang].tiles.map((t) => `${t.slug}|${t.subtype ?? state.bySlug.get(t.slug).subtypes?.[0] ?? ''}×${t.qty}`);
      const have = scan.rows.filter((r) => r.item && !r.ambiguous).map((r) => `${r.item.slug}|${r.subtype ?? ''}×${r.qty}`);
      const missing = want.filter((w) => !have.includes(w)), extra = have.filter((x) => !want.includes(x));
      // Synthetic Cyrillic/Chinese text is harder to read: one name may stay unclear there (the player picks it),
      // but nothing may be matched to the wrong item, and the Radiant relic must be found.
      const allowedMissing = ['en', 'es'].includes(lang) ? 0 : 1;
      await report(`${lang} screenshot: ${12 - allowedMissing}+ of 12 items with counts, the Radiant relic, nothing wrong`,
        missing.length <= allowedMissing && !extra.length && have.includes('axi_a1_relic|radiant×1') && !scan.shots[0].error,
        `${scan.shots[0].error ?? ''} missing: ${missing.join(' ') || 'none'}, wrong/extra: ${extra.join(' ') || 'none'}, unclear: ${scan.rows.filter((r) => r.ambiguous || !r.item).map((r) => r.text).join(' / ')}, ${scan.shots[0].seconds.toFixed(1)}s`);
    }
    await report('game language remembered', localStorage.getItem('scanLang') === 'en');

    // Sold 1 of 2 (prompt answers 1)
    document.querySelector('tr[data-key^="kogake_prime_boot|"] [data-action=sold]').click();
    await until(() => state.inventory.find((e) => e.slug === 'kogake_prime_boot')?.qty === 1 && state.sales.length === 1, 15000, 'sold');
    orders = await mockJson('/_orders');
    await report('sold closes the order and lowers the list', orders[0]?.quantity === 1, JSON.stringify(orders));

    // Sale on the website, picked up by the page
    await fetch(`${MOCK}/_sell-on-site?itemId=${orders[0].itemId}`);
    await loadListings(true);
    // The last unit sold on the website makes the order vanish, which looks like a delete: expect the "gone" prompt.
    await until(() => state.inventory.find((e) => e.slug === 'kogake_prime_boot')?.gone, 10000, 'gone flag');
    await report('vanished listing flagged for confirmation', !document.getElementById('goneBanner').hidden, document.getElementById('status').textContent);
    document.querySelector('tr[data-key^="kogake_prime_boot|"] [data-action=gone-sold]').click();
    await until(() => !state.inventory.some((e) => e.slug === 'kogake_prime_boot'), 10000, 'confirm sold');
    await report('confirming the sale removes the row', true, `${state.inventory.length} rows`);

    // Background script has the backend and sees the login
    try {
      // Firefox runs it as a background page; Chrome and Edge as a service worker, which a page can't look into.
      const bg = browser.runtime.getBackgroundPage ? await browser.runtime.getBackgroundPage().catch(() => null) : null;
      const alarm = await browser.alarms.get('check-orders');
      await report('background script loaded and sale checks scheduled', (!bg || (typeof bg.notifySales === 'function' && typeof bg.t === 'function'))
        && alarm?.periodInMinutes === 3, `${bg ? 'background page' : 'service worker'} ${JSON.stringify(alarm)}`);
    } catch (e) {
      await report('background script loaded and sale checks scheduled', false, e.message);
    }

    // Backup export contents + import of an old local-app file
    const backup = await Backend.exportData();
    await report('backup export', backup.inventory.length === 18 && backup.sales.length === 2, `${backup.inventory.length} items, ${backup.sales.length} sales`);
    await importBackup(new File([JSON.stringify([{ slug: 'serration', qty: 3, rank: 10, subtype: null }, { slug: 'ash_prime_systems_blueprint', qty: 2, rank: null, subtype: null }])], 'inventory.json'));
    await until(() => state.inventory.length === 2, 10000, 'import');
    await report('old local-app inventory imported', true, inv());
    await capture('table');

    // Persistence: storage holds the same list the page shows
    const stored = await Backend.getInventory();
    await report('list stored in browser storage', stored.map((e) => `${e.slug}:${e.qty}`).join(' ') === inv(), stored.length);

    // "Clear unlisted" keeps listed items
    await fetch(`${MOCK}/_list-on-site?itemId=${akId}&qty=1&platinum=15`);
    await loadListings(true);
    await until(() => state.inventory.some((e) => e.slug === 'akstiletto_prime_blueprint'), 10000, 'relisted');
    click('#clearBtn');
    await until(() => state.inventory.length === 1, 10000, 'clear unlisted');
    await report('"Clear unlisted" keeps listed items', state.inventory[0].slug === 'akstiletto_prime_blueprint', inv());

    // Price guard + bulk listing skips: one normal item, one priced far too low, one mod with unknown rank
    addEntries([{ slug: 'soma_prime_barrel', qty: 1, rank: null }, { slug: 'ash_prime_systems_blueprint', qty: 1, rank: null }, { slug: 'vitality', qty: 1, rank: null }]);
    await until(() => ['soma_prime_barrel', 'ash_prime_systems_blueprint'].every((sl) => state.prices.get(rowKey(state.inventory.find((e) => e.slug === sl)))?.fetchedAt), 30000, 'prices for guard test');
    const ash = state.inventory.find((e) => e.slug === 'ash_prime_systems_blueprint');
    const ashRow = () => buildRow(ash);
    ash.price = 1; render();
    const looksLow = underpriced(ashRow());
    await report('price far below the median is flagged', looksLow && document.querySelector('tr[data-key^="ash_prime_systems_blueprint|"] [data-field=price]').classList.contains('too-low'),
      `1p vs median ${ashRow().medianSell}p (${ashRow().price?.sellers} sellers)`);
    confirmAnswer = false;
    await listEntry(ash);
    await sleep(500);
    await report('listing a too-low price asks first (answered No: nothing listed)', /far below/.test(lastConfirm) && !(await mockJson('/_orders')).some((o) => o.itemId === state.bySlug.get('ash_prime_systems_blueprint').id));
    confirmAnswer = true;
    // The normal item is priced at its median so the check doesn't depend on live market prices.
    const soma = state.inventory.find((e) => e.slug === 'soma_prime_barrel');
    soma.price = buildRow(soma).medianSell;
    const before = (await mockJson('/_orders')).length;
    await listAllUnlisted();
    const listedNow = (await mockJson('/_orders')).map((o) => state.byId.get(o.itemId)?.slug);
    await report('bulk listing skips rank-unknown and too-low items', listedNow.length === before + 1 && listedNow.includes('soma_prime_barrel')
      && /rank not set.*Vitality/s.test(lastConfirm) && /price looks too low.*Ash Prime Systems Blueprint/s.test(lastConfirm), `${listedNow.join(' ')} | confirm: ${lastConfirm.slice(0, 300)} | status: ${document.getElementById('status').textContent}`);

    // A scanned Radiant relic gets its own row next to the Intact one (the English language scan from above)
    document.getElementById('scanMode').value = 'add';
    click('#scanAdd');
    await until(() => state.inventory.filter((e) => e.slug === 'axi_a1_relic').length === 2, 10000, 'relic rows');
    await report('Radiant and Intact relics are separate rows', ['intact', 'radiant'].every((s) => state.inventory.some((e) => e.slug === 'axi_a1_relic' && e.subtype === s)),
      state.inventory.filter((e) => e.slug === 'axi_a1_relic').map((e) => `${e.subtype}×${e.qty}`).join(' '));

    // Pricing ignores your own listing: you're one of the online sellers whenever you're online
    const ak = () => state.inventory.find((e) => e.slug === 'akstiletto_prime_blueprint');
    const akPrice = state.prices.get(rowKey(ak()));
    state.prices.set(rowKey(ak()), { ...akPrice, lowestSell: 5, sellOrders: [{ platinum: 5, user: 'mocktenno' }, { platinum: 9, user: 'someone' }] });
    const own = buildRow(ak());
    state.prices.set(rowKey(ak()), akPrice);
    await report('your own listing is left out of the price to beat', own.lowestOther === 9 && own.sellAt === 9 - Number(document.getElementById('undercut').value || 0), `lowest other ${own.lowestOther}, sell at ${own.sellAt}`);

    // Reprice: a listing far above the market moves to the default price; your own "Sell at" price is kept
    // Fixed, fresh market data for this item, so live prices can't make the price guard skip it.
    const akOrder = () => state.listings.get('akstiletto_prime_blueprint')?.[0];
    const realAkStats = state.stats.get('akstiletto_prime_blueprint');
    state.prices.set(rowKey(ak()), { lowestSell: 20, medianSell: 22, bestBuy: 15, sellers: 5, buyers: 1, fetchedAt: Date.now(),
      sellOrders: [20, 21, 22, 23, 25].map((platinum) => ({ platinum, user: 'someone' })) });
    state.stats.set('akstiletto_prime_blueprint', { fetchedAt: Date.now(), days: [] });
    await Backend.updateOrder(akOrder().id, { platinum: 999 });
    await loadListings(true);
    await repriceListings();
    await until(() => akOrder() && akOrder().platinum !== 999, 15000, 'reprice');
    const akTarget = buildRow(ak()).sellAt;
    if (realAkStats) state.stats.set('akstiletto_prime_blueprint', realAkStats); else state.stats.delete('akstiletto_prime_blueprint');
    await report('reprice moves listings to the default price and keeps your own prices', akOrder().platinum === akTarget
      && /Akstiletto Prime Blueprint: 999p →/.test(lastConfirm) && /Kept your own "Sell at" price.*Soma Prime Barrel/s.test(lastConfirm),
      `now ${akOrder().platinum}p, target ${akTarget}p | ${lastConfirm.slice(0, 250)}`);

    // Hide one listing, then show all
    document.querySelector('#tableListed tr[data-key^="akstiletto_prime_blueprint|"] [data-action=toggle-visible]').click();
    await until(() => akOrder()?.visible === false, 15000, 'hide');
    const hiddenOnSite = (await mockJson('/_orders')).find((o) => o.id === akOrder().id)?.visible === false;
    await report('Hide keeps the listing but hides it', hiddenOnSite && document.querySelector('#tableListed tr[data-key^="akstiletto_prime_blueprint|"] [data-action=toggle-visible]').textContent === 'Show');
    click('#showAllBtn');
    await until(() => [...state.listings.values()].flat().every((o) => o.visible !== false), 15000, 'show all');
    await report('Show all makes every listing visible', (await mockJson('/_orders')).every((o) => o.visible !== false));

    // Baro: an unlisted part (1 of 3), then a listed one entirely, which removes its listing
    const redeemer = state.inventory.find((e) => e.slug === 'redeemer_prime_blade');
    const redeemerQty = redeemer.qty;
    document.querySelector('tr[data-key^="redeemer_prime_blade|"] [data-action=baro]').click();
    await until(() => state.sales.at(-1)?.slug === 'redeemer_prime_blade', 10000, 'baro');
    const baroSale = state.sales.at(-1);
    await report('Baro removes the items and records ducats', redeemer.qty === redeemerQty - 1 && baroSale.platinum === null
      && baroSale.ducats === state.bySlug.get('redeemer_prime_blade').ducats && /ducats/.test(document.getElementById('salesSummary').textContent),
      `${redeemer.qty} left, sale ${JSON.stringify(baroSale)}, ${document.getElementById('salesSummary').textContent}`);
    const somaEntry = state.inventory.find((e) => e.slug === 'soma_prime_barrel');
    promptAnswer = String(somaEntry.qty);
    document.querySelector('#tableListed tr[data-key^="soma_prime_barrel|"] [data-action=baro]').click();
    await until(() => !state.inventory.some((e) => e.slug === 'soma_prime_barrel'), 15000, 'baro listed');
    promptAnswer = '1';
    await report('Baro on a listed item removes its listing', !(await mockJson('/_orders')).some((o) => o.itemId === state.bySlug.get('soma_prime_barrel').id));

    // Screenshots taken at different times: the newest count seen wins, and a tile without a visible count
    // (none shown, or cut off) keeps the earlier one. Made-up readings, so this doesn't depend on OCR.
    const det = (slug, qty, counted) => ({ match: { item: state.bySlug.get(slug), score: 1, ambiguous: false, subtype: null }, qty,
      countBox: counted ? { x0: 0, y0: 0, x1: 1, y1: 1 } : null, text: slug, norm: slug, segs: [slug] });
    const shotsOf = (...list) => list.map(([time, dets], i) => ({ id: 900 + i, name: `t${time}.png`, time, status: 'done', detections: dets }));
    const scanRow = (slug) => scan.rows.find((r) => r.item?.slug === slug);
    click('#scanClear');
    scan.shots = shotsOf([2000, [det('hornet_strike', 2, true), det('vitality', 1, false)]], [1000, [det('hornet_strike', 3, true), det('vitality', 2, true)]]);
    aggregate();
    await report('newest visible count wins; no visible count keeps the earlier one', scanRow('hornet_strike').qty === 2 && scanRow('vitality').qty === 2,
      scan.rows.map((r) => `${r.item.slug}×${r.qty}${r.qtySeen ? '' : '?'}`).join(' '));
    const vitality = () => state.inventory.find((e) => e.slug === 'vitality');
    vitality().qty = 7;
    document.getElementById('scanMode').value = 'set';
    scan.shots = shotsOf([3000, [det('vitality', 1, false)]]);
    aggregate();
    click('#scanAdd');
    const keptQty = vitality().qty;
    scan.shots = shotsOf([4000, [det('vitality', 4, true)]]);
    aggregate();
    click('#scanAdd');
    await report('re-scan keeps your quantity when no count is visible, and updates it when one is', keptQty === 7 && vitality().qty === 4, `${keptQty} then ${vitality().qty}`);
    click('#scanClear');

    // Price history: completed trades over the last 7 days, matched to the row's rank
    const akRowEl = () => document.querySelector('#tableListed tr[data-key^="akstiletto_prime_blueprint|"]');
    await until(() => state.stats.has('akstiletto_prime_blueprint') && akRowEl()?.children[5].textContent !== '…', 40000, 'history');
    const akRow = buildRow(ak());
    await report('price history loaded and shown', typeof akRow.hist?.trades === 'number' && akRowEl().children[5].textContent === (akRow.avg7 === null ? '—' : String(akRow.avg7)),
      `7-day avg ${akRow.avg7}p from ${akRow.hist?.trades} trades, ${akRow.perDay?.toFixed(1)}/day`);
    const day = 24 * 60 * 60 * 1000;
    const realSerration = state.stats.get('serration');
    state.stats.set('serration', { fetchedAt: Date.now(), days: [
      { at: Date.now() - day, volume: 2, price: 40, rank: 10, subtype: null },
      { at: Date.now() - day, volume: 3, price: 5, rank: 0, subtype: null },
      { at: Date.now() - 10 * day, volume: 50, price: 99, rank: 10, subtype: null }] });
    const r10 = history({ slug: 'serration', rank: 10, subtype: null });
    if (realSerration) state.stats.set('serration', realSerration); else state.stats.delete('serration');
    await report('history uses the row\'s rank and only the last 7 days', r10.avg === 40 && r10.trades === 2, JSON.stringify(r10));
    const lowVsHistory = { sellAt: 10, medianSell: null, price: { sellers: 0 }, avg7: 40, hist: { trades: 12 } };
    await report('a price far below the 7-day average is flagged', underpriced(lowVsHistory) && !underpriced({ ...lowVsHistory, hist: { trades: 2 } }));

    // Complete sets: Combine turns the parts into one set row (a part listed separately loses its listing);
    // Split turns it back. One part is owned once more than the set needs.
    const somaSet = await Backend.getSet('soma_prime_set');
    const parts = somaSet.parts;
    const qtyOf = (slug) => state.inventory.filter((e) => e.slug === slug).reduce((n, e) => n + e.qty, 0);
    const partsBefore = new Map(parts.map((p) => [p.slug, qtyOf(p.slug)]));
    addEntries(parts.map((p, i) => ({ slug: p.slug, qty: p.quantityInSet + (i === 0 ? 1 : 0), rank: null })));
    const listedPart = parts[1].slug;
    await fetch(`${MOCK}/_list-on-site?itemId=${state.bySlug.get(listedPart).id}&qty=${qtyOf(listedPart)}&platinum=50`);
    await loadListings(true);
    await computeSets();
    await until(() => document.querySelector('#setsTable [data-set="soma_prime_set"]'), 30000, 'complete set shown');
    document.querySelector('#setsTable [data-set="soma_prime_set"]').click();
    await until(() => qtyOf('soma_prime_set') === 1, 20000, 'combined');
    await report('Combine turns the parts into a set row and lowers part listings', qtyOf(parts[0].slug) === partsBefore.get(parts[0].slug) + 1
      && parts.slice(1).every((p) => qtyOf(p.slug) === partsBefore.get(p.slug)) && /lowered or removed/.test(lastConfirm)
      && !(await mockJson('/_orders')).some((o) => o.itemId === state.bySlug.get(listedPart).id),
      parts.map((p) => `${p.slug}×${qtyOf(p.slug)}`).join(' '));
    document.querySelector('tr[data-key^="soma_prime_set|"] [data-action=split]').click();
    await until(() => qtyOf('soma_prime_set') === 0, 20000, 'split');
    await report('Split turns the set back into its parts', parts.every((p, i) => qtyOf(p.slug) === partsBefore.get(p.slug) + p.quantityInSet + (i === 0 ? 1 : 0)),
      parts.map((p) => `${p.slug}×${qtyOf(p.slug)}`).join(' '));

    // Page language: every marked text has a translation, switching to Ukrainian translates the page, item
    // names and built rows (inputs inside translated labels survive), the trade message stays English
    const pageKeys = [...document.querySelectorAll('[data-i18n]')].map((el) => el.i18n?.key)
      .concat([...document.querySelectorAll('[data-i18n-attr]')].flatMap((el) => Object.values(el.i18nAttrs ?? {})));
    const untranslated = ['uk', 'es', 'zh-hans', 'zh-hant'].flatMap((l) => pageKeys.filter((k) => k && !(k in LOCALES[l])).map((k) => `${l}: ${k}`));
    await report('every text on the page has a translation', pageKeys.length > 80 && !untranslated.length, `${pageKeys.length} texts; ${untranslated.slice(0, 5).join(' | ')}`);
    const pageLang = document.getElementById('pageLang');
    pageLang.value = 'uk';
    pageLang.dispatchEvent(new Event('change'));
    const ukNames = await Backend.getItemNames('uk');
    await until(() => state.names && document.querySelector('#tableListed tr[data-key^="akstiletto_prime_blueprint|"] .item a')?.textContent === ukNames.akstiletto_prime_blueprint, 20000, 'Ukrainian page');
    const headerCells = [...document.querySelectorAll('#tableUnlisted thead th')].map((th) => th.textContent);
    await report('switching the page to Ukrainian translates text, headers, buttons and item names',
      document.querySelector('#scanCard h2').textContent === 'Сканування знімків екрана' && headerCells[0] === 'Предмет'
      && /Виставити все невиставлене/.test(document.getElementById('listAllBtn').textContent)
      && document.querySelector('#tableListed [data-action=unlist]')?.textContent === 'Зняти'
      && document.querySelector('label #fMin') && document.querySelector('label #scanLang') && document.documentElement.lang === 'uk',
      `${document.querySelector('#scanCard h2').textContent} | ${headerCells.slice(0, 4).join(', ')} | ${document.querySelector('#tableListed .item a')?.textContent}`);
    window.scrollTo(0, 0); await sleep(300); await capture('ukrainian-top');
    document.getElementById('listedSection').scrollIntoView(); await sleep(300); await capture('ukrainian-table');
    await report('the trade chat message keeps the English names', /\[Akstiletto Prime Blueprint\]/.test(document.getElementById('tradeMsg').value), document.getElementById('tradeMsg').value.slice(0, 120));
    await report('the language choice is saved for notifications too', (await Backend.getSettings({ fresh: true })).pageLang === 'uk' && localStorage.getItem('pageLang') === 'uk');
    pageLang.value = 'en';
    pageLang.dispatchEvent(new Event('change'));
    await until(() => document.querySelector('#scanCard h2').textContent === 'Scan screenshots' && state.names === null, 10000, 'back to English');
    await report('switching back to English restores it', document.querySelector('#tableUnlisted thead th').textContent === 'Item'
      && document.querySelector('#tableListed .item a')?.textContent === 'Akstiletto Prime Blueprint');

    // The row menu and the page's own dialog, for a visual check
    const rowMenuEl = document.querySelector('#tableListed tr[data-key] details.row-menu');
    rowMenuEl.scrollIntoView({ block: 'center' });
    rowMenuEl.open = true;
    await sleep(400); await capture('row-menu');
    rowMenuEl.open = false;
    const dialogAnswer = openDialog(t('Remove every item that is not listed on warframe.market? Listed items and your listings stay.'), { danger: true });
    await sleep(400); await capture('dialog');
    document.getElementById('dialog').close('cancel');
    await report('page dialogs open and answer', (await dialogAnswer) === false && rowMenuEl.querySelectorAll('.menu-item').length >= 3);

    // Logging out on the website is noticed
    await phase('need-logout');
    await until(() => !state.auth.connected, 30000, 'logout');
    await report('logout on the website is noticed', true, document.getElementById('accountText').textContent);
  } catch (err) {
    await report('self-test crashed', false, err.message + ' | status: ' + document.getElementById('status').textContent);
    await capture('error');
  } finally {
    await phase('done');
  }
})();
