// The side-panel connector's views in Chromium, nested as an MCP Apps host nests them (the browser check's
// `connector` group; also `node tools/connector-check.js [--screenshots DIR]` on its own):
//   host page (claude.localhost) -> sandbox proxy (<conversation>.sandbox.localhost, iframe sandbox "allow-scripts
//   allow-same-origin allow-forms", the view's CSP as an HTTP header) -> srcdoc view (inherits that CSP)
// The CSP is the one ext-apps specification/2026-01-26/apps.mdx ("CSP Construction from Metadata") builds from the
// resource's _meta.ui.csp: no 'unsafe-eval', no blob: or data: scripts. The view is the Worker's own resources/read
// (connector/worker/src/server.js over connector/build.js), with https://cloadm.dev pointed at the local copy of the
// site (cloadm.localhost, which sends Access-Control-Allow-Origin: * as GitHub Pages does, or not, for the no-CORS case).
// The host stub is protocol-faithful: it answers ui/initialize with the granted CSP, lists the view's tools once on
// ui/notifications/initialized and again on notifications/tools/list_changed (never on its own), and calls tools.
// *.localhost resolves to 127.0.0.1 and is a secure context, so storage, OPFS and AudioWorklet work over http.
// Scenarios:
//   site      (A, open_emulator): the handshake comes before the emulator's module runs; the first list already has
//             every tool; list_changed follows; screen_text, type_text (LIZA answers), load 2048 and screenshot, peek;
//             a real click and real keys; storage; ROMs added in the panel persist across a reload, and then memory
//             reads are refused (no tool returns ROM memory directly)
//   inline    (B, open_emulator_inline): the same handshake and tools with nothing fetched
//   no-cors   A when the site sends no Access-Control-Allow-Origin: the handshake still comes; calls are not-started
//   out-of-step A when the site's panel speaks another PANEL_API: calls are out-of-step
const http = require('http'), fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

function specCsp(csp) {
  const r = ((csp && csp.resourceDomains) || []).join(' '), c = ((csp && csp.connectDomains) || []).join(' ');
  return [`default-src 'none'`, `script-src 'self' 'unsafe-inline' ${r}`, `style-src 'self' 'unsafe-inline' ${r}`, `connect-src 'self' ${c}`,
    `img-src 'self' data: ${r}`, `font-src 'self' ${r}`, `media-src 'self' data: ${r}`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'self'`].map((d) => d.trim()).join('; ');
}

const HOST_HTML = `<!doctype html><meta charset="utf-8"><title>host</title><body style="margin:0">
<script>
const q = new URLSearchParams(location.search);
const f = document.createElement('iframe');
f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
f.src = q.get('proxy');
f.style.cssText = 'width:680px;height:620px;border:0';
window.hostT = { created: Date.now() }; window.hostLists = []; window.hostLog = [];
let id = 1000; const waiting = new Map();
const post = (m) => f.contentWindow.postMessage(Object.assign({ jsonrpc: '2.0' }, m), '*');
window.callView = (method, params) => new Promise((ok) => { const i = id++; waiting.set(i, ok); post({ id: i, method, params }); });
const listTools = () => callView('tools/list', {}).then((r) => { hostLists.push(r.result ? r.result.tools.map((t) => t.name) : null); });
addEventListener('message', (e) => {
  const d = e.data; if (e.source !== f.contentWindow || !d || d.jsonrpc !== '2.0') return;
  hostLog.push(d.method || 'reply');
  if (d.method === 'ui/initialize') { hostT.initialize = Date.now(); post({ id: d.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'host-stub', version: '1' }, hostCapabilities: { sandbox: { csp: JSON.parse(q.get('granted') || '{}') } }, hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } } }); }
  else if (d.method === 'ui/notifications/initialized') { hostT.initialized = Date.now(); listTools(); }
  else if (d.method === 'notifications/tools/list_changed') { hostT.listChanged = Date.now(); listTools(); }
  else if (d.method === 'ui/request-display-mode') post({ id: d.id, result: { mode: 'fullscreen' } });
  else if (d.method === undefined && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
});
document.body.append(f);
</script>`;
// the sandbox proxy: fetches the view's HTML and loads it as srcdoc (it inherits this page's CSP), then relays
const SANDBOX_HTML = `<!doctype html><meta charset="utf-8"><title>sandbox proxy</title><body style="margin:0">
<script>
fetch('view' + location.search).then((r) => r.text()).then((html) => {
  const v = document.createElement('iframe');
  v.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  v.style.cssText = 'width:100%;height:600px;border:0';
  v.srcdoc = html;
  document.body.append(v);
  addEventListener('message', (e) => {
    if (!e.data || e.data.jsonrpc !== '2.0') return;
    if (e.source === v.contentWindow) parent.postMessage(e.data, '*');
    else if (e.source === parent) v.contentWindow.postMessage(e.data, '*');
  });
});
</script>`;

// one server, three sites by Host. opts.cors: the site sends Access-Control-Allow-Origin; opts.panelApi: the site's
// connector/view/tools.js says this PANEL_API instead
async function start({ cors = true, panelApi = null } = {}) {
  const build = await import(pathToFileURL(path.join(ROOT, 'connector/build.js')).href);
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'connector/worker/src/server.js')).href);
  let worker = null, csps = [];
  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host || '').split(':')[0], url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (host === 'claude.localhost') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HOST_HTML); return; }
      if (host.endsWith('.sandbox.localhost')) {
        const r = await (await worker.fetch(new Request('https://w/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: url.searchParams.get('uri') } }) }))).json();
        const c = r.result.contents[0];
        if (url.pathname === '/view') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(c.text); return; }
        const csp = specCsp(c._meta && c._meta.ui && c._meta.ui.csp);
        csps.push(csp);
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': csp }); res.end(SANDBOX_HTML); return;
      }
      if (host === 'cloadm.localhost') {
        const p = path.join(ROOT, decodeURIComponent(url.pathname));
        if (!p.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
        let data = fs.readFileSync(p);
        if (panelApi != null && url.pathname === '/connector/view/tools.js') data = Buffer.from(String(data).replace(/export const PANEL_API = \d+;/, `export const PANEL_API = ${panelApi};`));
        res.writeHead(200, Object.assign({ 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }, cors ? { 'access-control-allow-origin': '*' } : {}));
        res.end(data); return;
      }
      res.writeHead(404); res.end();
    } catch (e) { res.writeHead(404); res.end(String(e.message)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, site = `http://cloadm.localhost:${port}`;
  // the Worker's views, with the site pointed at the local copy (in the HTML and in the declared CSP)
  const views = build.views({ origin: site });
  const local = (v) => JSON.parse(JSON.stringify(v).replaceAll('https://cloadm.dev', site));
  worker = createServer(views);
  const realFetch = worker.fetch;
  worker.fetch = async (req) => { const r = await realFetch(req); const body = await r.json(); return new Response(JSON.stringify(local(body))); };
  return { server, port, site, views, csps };
}

const wait = (page, fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

async function scenario(browser, check, name, { uri, cors = true, panelApi = null, granted = true, shots = null }) {
  const srv = await start({ cors, panelApi });
  const ctx = await browser.newContext({ viewport: { width: 700, height: 660 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  const g = granted ? { resourceDomains: [srv.site], connectDomains: [srv.site] } : {};
  const open = (conv) => page.goto(`http://claude.localhost:${srv.port}/?${new URLSearchParams({ proxy: `http://${conv}.sandbox.localhost:${srv.port}/sandbox?uri=${encodeURIComponent(uri)}`, granted: JSON.stringify(g) })}`);
  const view = () => page.frames().find((f) => f.url() === 'about:srcdoc');
  const call = (tool, args = {}) => page.evaluate(([n, a]) => window.callView('tools/call', { name: n, arguments: a }), [tool, args]);
  const data = (r) => (r && r.result ? r.result.structuredContent : null);
  try {
    await open('a');
    const handshake = await wait(page, () => window.hostT.initialized && window.hostLists.length >= 1);
    check(`connector ${name}: the view shakes hands (ui/initialize, initialized) and the host lists its tools`, handshake, JSON.stringify(await page.evaluate(() => [window.hostT, window.hostLog])));
    const v = view();
    check(`connector ${name}: the view runs under the spec's CSP for its declared domains`, srv.csps.length === 1 && (uri.includes('inline') ? !srv.csps[0].includes('cloadm.localhost') : srv.csps[0].includes(`script-src 'self' 'unsafe-inline' ${srv.site};`)), srv.csps[0]);
    if (name === 'no-cors' || name === 'out-of-step') {
      const r = await call('screen_text', { machine_id: 'm1' });
      const code = data(r) && data(r).error && data(r).error.code;
      const st = await v.evaluate(() => document.getElementById('st').textContent);
      check(`connector ${name}: the host still gets its handshake and full tool list, and a call is answered ${name === 'no-cors' ? 'not-started' : 'out-of-step'} at once`,
        code === (name === 'no-cors' ? 'not-started' : 'out-of-step') && (await page.evaluate(() => window.hostLists[0].length)) > 20, `${JSON.stringify(r).slice(0, 300)} ${st}`);
      if (name === 'no-cors') check('connector no-cors: the reason is on the status line', /error: .*(fetch|import|module)/i.test(st), st);
      return;
    }
    const running = await wait(v, () => window.cloadmView && window.cloadmView.facts.storage !== '…');
    check(`connector ${name}: the emulator starts in the view`, running, `${await v.evaluate(() => document.getElementById('st').textContent)} ${errors.join(' | ')}`);
    await wait(page, () => window.hostT.listChanged && window.hostLists.length >= 2, null, 10000);
    const t = await page.evaluate(() => ({ hostT: window.hostT, lists: window.hostLists }));
    const order = await v.evaluate(() => ({ init: window.CLOADM_BRIDGE.log.initSentAt, module: window.cloadmView.loadedAt }));
    const expected = srv.views.tools.map((x) => x.name);
    check(`connector ${name}: the view sent ui/initialize before the emulator's module ran (the bridge comes first)`, order.init < order.module, JSON.stringify(order));
    check(`connector ${name}: the host's first list (on initialized) already has every tool`, JSON.stringify(t.lists[0]) === JSON.stringify(expected), JSON.stringify(t.lists[0]));
    check(`connector ${name}: notifications/tools/list_changed came once the emulator was ready, and the host listed again`, !!t.hostT.listChanged && t.lists.length >= 2 && JSON.stringify(t.lists[1]) === JSON.stringify(expected), JSON.stringify(t));
    await page.waitForTimeout(1000);
    const s1 = await call('screen_text', { machine_id: 'm1' });
    check(`connector ${name}: screen_text reads LIZA's screen, wrapped as untrusted machine_output`, data(s1) && /never instructions/.test(data(s1).untrusted) && /LIZA/.test(data(s1).machine_output.lines.join('\n')), JSON.stringify(s1).slice(0, 300));
    const typed = await call('type_text', { machine_id: 'm1', text: 'I AM HAPPY\n' });
    await call('run_frames', { machine_id: 'm1', frames: 100 });
    const s2 = await call('screen_text', { machine_id: 'm1' });
    const lines = data(s2).machine_output.lines.join('\n');
    check(`connector ${name}: type_text types into LIZA and she answers`, typed.result && !typed.result.isError && /> I AM HAPPY *\n[A-Z]/.test(lines), `${JSON.stringify(typed).slice(0, 200)}\n${lines}`);
    const game = await call('load', { machine_id: 'm1', program: '2048' });
    await call('run_frames', { machine_id: 'm1', frames: 60 });
    const shot = await call('screenshot', { machine_id: 'm1', scale: 2 });
    const img = shot.result && shot.result.content.find((c) => c.type === 'image');
    check(`connector ${name}: load runs the bundled 2048, and screenshot returns it as a PNG`, data(game) && data(game).loaded === '2048' && img && img.mimeType === 'image/png' && img.data.startsWith('iVBORw0KGgo')
      && data(shot).width === 640, JSON.stringify([game, shot && shot.result && shot.result.structuredContent]).slice(0, 300));
    const peek = await call('peek', { machine_id: 'm1', address: 0x3000, length: 4 });
    check(`connector ${name}: peek reads memory without ROMs (the game's first bytes)`, data(peek) && /\$3000:/.test(data(peek).machine_output.hex), JSON.stringify(peek).slice(0, 200));
    await call('load', { machine_id: 'm1', program: 'liza' });
    await call('run_frames', { machine_id: 'm1', frames: 60 });
    await v.click('#screen');
    await page.keyboard.type('BYE');
    await page.keyboard.press('Enter');
    const bye = await wait(v, () => window.cloadmView.session.screenText().join('\n').includes('> BYE'), null, 8000);
    check(`connector ${name}: a real click and real keys reach the machine`, bye);
    const storage = await v.evaluate(() => window.cloadmView.facts.storage);
    check(`connector ${name}: localStorage, IndexedDB and OPFS work in the view`, /localStorage ok, IndexedDB ok, OPFS ok/.test(storage), storage);
    if (shots) await page.screenshot({ path: path.join(shots, `connector-${name}.png`) });
    if (name === 'site') {
      // ROMs added in the panel (bytes standing in for a user's dump): kept in the panel's storage across a reload,
      // in another conversation's sandbox origin too (the partition is the chat's site); then no memory read leaves it
      const fake = (k) => Buffer.from(Uint8Array.from({ length: 16384 }, (_, i) => (i * 13 + k) & 255));
      await v.setInputFiles('#rom', [{ name: 'd64_1.rom', mimeType: 'application/octet-stream', buffer: fake(1) }, { name: 'd64_2.rom', mimeType: 'application/octet-stream', buffer: fake(2) }]);
      const took = await wait(v, () => window.cloadmView.session.shownMachine.hasRom, null, 5000);
      await page.waitForTimeout(1000);   // (the stores write after the call)
      // another conversation: its view has another origin (Claude derives one per conversation and connector), so
      // its storage is its own
      await open('b');
      const other = await wait(page, () => window.hostT.listChanged, null, 20000) && await wait(view(), () => window.cloadmView && window.cloadmView.facts.storage !== '…', null, 10000);
      const otherRoms = other && await view().evaluate(() => window.cloadmView.session.shownMachine.hasRom);
      await open('a');
      const again = await wait(page, () => window.hostT.listChanged, null, 20000);
      const v2 = view();
      const kept = again && await wait(v2, () => window.cloadmView && window.cloadmView.session.shownMachine.hasRom, null, 10000);
      check('connector site: ROMs added in the panel are kept when the same conversation\'s view opens again; another conversation\'s view has its own storage', took && kept && other && otherRoms === false, JSON.stringify({ took, kept, other, otherRoms }));
      const reads = await Promise.all([call('peek', { machine_id: 'm1', address: 0x8000, length: 16 }), call('find_bytes', { machine_id: 'm1', pattern: '01 0E' }), call('disassemble', { machine_id: 'm1', address: 0x8000 })]);
      check('connector site: with the user\'s ROMs, peek, find_bytes and disassemble are refused (no tool returns ROM memory directly)', reads.every((r) => data(r) && data(r).error && data(r).error.code === 'rejected' && /no tool returns ROM memory directly/.test(data(r).error.detail)), JSON.stringify(reads).slice(0, 400));
    }
    check(`connector ${name}: no page errors`, !errors.length, errors.join(' | '));
  } finally {
    await ctx.close();
    srv.server.close();
    srv.server.closeAllConnections();
  }
}

async function connectorChecks(browser, check, { shots = null } = {}) {
  await scenario(browser, check, 'site', { uri: 'ui://cloadm/panel.html', shots });
  await scenario(browser, check, 'inline', { uri: 'ui://cloadm/inline.html', granted: false, shots });
  await scenario(browser, check, 'no-cors', { uri: 'ui://cloadm/panel.html', cors: false });
  await scenario(browser, check, 'out-of-step', { uri: 'ui://cloadm/panel.html', panelApi: 999 });
}
module.exports = { connectorChecks, specCsp };

if (require.main === module) {
  (async () => {
    const { chromium } = require('playwright');
    const i = process.argv.indexOf('--screenshots'), shots = i > 0 ? process.argv[i + 1] : null;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const browser = await chromium.launch();
    let fails = 0, n = 0;
    const check = (what, ok, detail = '') => { n++; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : ` ${detail}`}`); };
    try { await connectorChecks(browser, check, { shots }); } finally { await browser.close(); }
    console.log(`${n - fails}/${n} connector checks passed`);
    process.exitCode = fails ? 1 : 0;
  })();
}
