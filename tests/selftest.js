'use strict';
/* global browser, state, scan, addShots, rowKey, loadListings, importBackup, Backend, renderPreview */
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
  window.confirm = (msg) => { lastConfirm = msg; return confirmAnswer; };
  window.prompt = () => '1';
  async function capture(name) {
    try { await post('/_shot', { name, data: await browser.tabs.captureVisibleTab() }); } catch (e) { await report('screenshot ' + name, false, e.message); }
  }

  try {
    await until(() => state.settings && (state.auth.reason === 'no-access' || state.items.length > 0), 40000, 'init');
    if (state.auth.reason === 'no-access') {
      await report('host permissions granted at install', false, 'banner shown; requesting');
      return;
    }
    await report('host permissions granted at install', true);
    await report('items loaded in add-on', state.items.length > 3000, state.items.length);
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
    addShots(files);
    await until(() => scan.shots.length === 2 && scan.shots.every((s) => s.status === 'done' || s.status === 'error'), 150000, 'scan');
    const errors = scan.shots.filter((s) => s.error).map((s) => s.error);
    const matched = scan.rows.filter((r) => r.item).length;
    await report('scan works with bundled Tesseract (18 matched)', matched === 18 && !errors.length,
      `${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${matched}, counts ${scan.rows.filter((r) => r.qty > 1).map((r) => r.item?.slug + '×' + r.qty).join(' ')} ${errors.join(';')}`);
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
        `${realRows.length} items, wrong qty: ${wrongQty.join(' ') || 'none'}, missing: ${missing.join(' ') || 'none'}`);
    }
    click('#scanClear');

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
      const bg = await browser.runtime.getBackgroundPage();
      const alarm = await browser.alarms.get('check-orders');
      await report('background script loaded and sale checks scheduled', typeof bg.notifySales === 'function' && alarm?.periodInMinutes === 3, JSON.stringify(alarm));
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
