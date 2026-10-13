// A stand-in for warframe.market used by the tests. It fakes everything tied to an account (login check,
// your orders, creating/updating/closing orders) so tests never touch a real account, and passes public
// read-only requests (items, prices, sets) through to the real API.
//
// Extra endpoints starting with "_" let a test act like the website (list or sell something there),
// read what the add-on did, and collect results reported by the in-page self-test.

const http = require('http');
const fs = require('fs');
const path = require('path');

const REAL_API = 'https://api.warframe.market';
const TOKEN = 'mock-token-123';
const LANGS = ['en', 'uk', 'es', 'zh-hans', 'zh-hant'];
const FIXTURES = ['mods-pick.png', 'relic-reward.png', 'relic-reward2.png', 'shotA.png', 'shotB.png', 'real1.png', 'real2.png', 'language-shots.json', ...LANGS.map((l) => `lang-${l}.png`)];

function startMock({ port = 3901, fixturesDir, outputDir, onReport = () => {} }) {
  const orders = new Map();
  const reports = [];
  const phases = [];
  let nextId = 1;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const findOrder = () => [...orders.values()].find((o) => o.itemId === url.searchParams.get('itemId'));

    // --- self-test plumbing ---
    if (url.pathname === '/_report') { reports.push(body); onReport(body); return send(200, {}); }
    if (url.pathname === '/_reports') return send(200, reports);
    if (url.pathname === '/_phase') { phases.push(url.searchParams.get('name')); return send(200, {}); }
    if (url.pathname === '/_phases') return send(200, phases);
    if (url.pathname === '/_shot') {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, `${path.basename(body.name)}.png`), Buffer.from(body.data.split(',')[1], 'base64'));
      return send(200, {});
    }
    if (FIXTURES.includes(url.pathname.slice(1))) {
      res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.json') ? 'application/json' : 'image/png' });
      return res.end(fs.readFileSync(path.join(fixturesDir, url.pathname.slice(1))));
    }

    // --- acting like the website / inspecting state ---
    if (url.pathname === '/_orders') return send(200, [...orders.values()]);
    if (url.pathname === '/_list-on-site') {
      const o = { id: `ord${nextId++}`, type: 'sell', itemId: url.searchParams.get('itemId'), platinum: Number(url.searchParams.get('platinum')), quantity: Number(url.searchParams.get('qty')), visible: true };
      orders.set(o.id, o);
      return send(200, o);
    }
    if (url.pathname === '/_sell-on-site') { // marks 1 sold, like the website's "Sold" button
      const o = findOrder();
      o.quantity -= 1;
      if (o.quantity <= 0) orders.delete(o.id);
      return send(200, { ok: true });
    }
    if (url.pathname === '/_delete-on-site') {
      orders.delete(findOrder().id);
      return send(200, { ok: true });
    }

    // --- the account part of the warframe.market API ---
    const needsAuth = url.pathname === '/v2/me' || url.pathname === '/v2/orders/my' || /^\/v2\/order(\/|$)/.test(url.pathname);
    if (needsAuth && req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    if (url.pathname === '/v2/me') return send(200, { data: { ingameName: 'MockTenno', slug: 'mocktenno' } });
    if (url.pathname === '/v2/orders/my') return send(200, { data: [...orders.values()] });
    if (url.pathname === '/v2/order' && req.method === 'POST') {
      const o = { id: `ord${nextId++}`, type: body.type, itemId: body.itemId, platinum: body.platinum, quantity: body.quantity, visible: body.visible, rank: body.rank, subtype: body.subtype };
      orders.set(o.id, o);
      return send(200, { data: o });
    }
    let m;
    if ((m = url.pathname.match(/^\/v2\/order\/([^/]+)\/close$/))) {
      const o = orders.get(m[1]);
      if (!o) return send(404, { error: 'not found' });
      o.quantity -= body.quantity;
      if (o.quantity <= 0) orders.delete(o.id);
      return send(200, { data: { id: 'tx1' } });
    }
    if ((m = url.pathname.match(/^\/v2\/order\/([^/]+)$/))) {
      const o = orders.get(m[1]);
      if (!o) return send(404, { error: 'not found' });
      if (req.method === 'PATCH') { Object.assign(o, body); return send(200, { data: o }); }
      if (req.method === 'DELETE') { orders.delete(o.id); res.writeHead(204); return res.end(); }
    }

    // --- everything else: real public data ---
    const r = await fetch(REAL_API + req.url, { headers: { Platform: 'pc', Language: req.headers.language || 'en' } });
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, TOKEN, reports, phases })));
}

module.exports = { startMock, TOKEN };
