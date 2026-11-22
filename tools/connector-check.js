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
//   phone     the size reported inline (ui/notifications/size-changed), the host's insets in fullscreen, the on-screen
//             keys on a touch screen (Keys | Pad | Stick, each program's mode, the choice remembered), a host that asks
//             before each call (phoneScenario)
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
f.style.cssText = \`width:\${q.get('w') || 680}px;height:\${q.get('h') || 620}px;border:0;display:block\`;
// the panel resized, and the host's context changing (displayMode: the side panel is 'fullscreen')
window.resizeView = (w, h) => { f.style.width = w + 'px'; f.style.height = h + 'px'; };
window.hostContextChanged = (params) => post({ method: 'ui/notifications/host-context-changed', params });
window.hostT = { created: Date.now() }; window.hostLists = []; window.hostLog = []; window.sizes = [];
// a host that asks the person before each of Claude's calls through the view: the call reaches the view only once
// approved (after ms), or never (denied: the host answers Claude itself and the view hears nothing)
window.callApproved = (name, args, { ms = 1500, deny = false } = {}) => new Promise((ok) => setTimeout(() => (deny ? ok({ denied: true }) : callView('tools/call', { name, arguments: args }).then(ok)), ms));
let id = 1000; const waiting = new Map();
const post = (m) => f.contentWindow.postMessage(Object.assign({ jsonrpc: '2.0' }, m), '*');
window.callView = (method, params) => new Promise((ok) => { const i = id++; waiting.set(i, ok); post({ id: i, method, params }); });
const listTools = () => callView('tools/list', {}).then((r) => { hostLists.push(r.result ? r.result.tools.map((t) => t.name) : null); });
addEventListener('message', (e) => {
  const d = e.data; if (e.source !== f.contentWindow || !d || d.jsonrpc !== '2.0') return;
  hostLog.push(d.method || 'reply');
  if (d.method === 'ui/initialize') { hostT.initialize = Date.now(); post({ id: d.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'host-stub', version: '1' }, hostCapabilities: { sandbox: { csp: JSON.parse(q.get('granted') || '{}') } }, hostContext: Object.assign({ displayMode: q.get('mode') || 'inline', availableDisplayModes: ['inline', 'fullscreen'] }, q.get('dims') ? { containerDimensions: JSON.parse(q.get('dims')) } : {}, JSON.parse(q.get('ctx') || '{}')) } }); }
  else if (d.method === 'ui/notifications/size-changed') {
    // an auto-sizing host (inline): the view's frame takes the height it reports (q autosize), as claude.ai's does
    sizes.push(d.params);
    if (q.get('autosize')) f.style.height = d.params.height + 'px';
  }
  else if (d.method === 'ui/notifications/initialized') { hostT.initialized = Date.now(); listTools(); }
  else if (d.method === 'notifications/tools/list_changed') { hostT.listChanged = Date.now(); listTools(); }
  else if (d.method === 'ui/request-display-mode') {
    // as a host does: the answer, then the new context (the side panel's fixed size)
    window.displayRequests = (window.displayRequests || []).concat([d.params.mode]);
    post({ id: d.id, result: { mode: 'fullscreen' } });
    post({ method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen', containerDimensions: { width: f.offsetWidth, height: f.offsetHeight } } });
  }
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
  v.style.cssText = 'width:100%;height:100vh;border:0;display:block';
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

async function scenario(browser, check, name, { uri, cors = true, panelApi = null, granted = true, shots = null, mode = 'inline' }) {
  const srv = await start({ cors, panelApi });
  const ctx = await browser.newContext({ viewport: { width: 700, height: 660 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  const g = granted ? { resourceDomains: [srv.site], connectDomains: [srv.site] } : {};
  const open = (conv) => page.goto(`http://claude.localhost:${srv.port}/?${new URLSearchParams({ proxy: `http://${conv}.sandbox.localhost:${srv.port}/sandbox?uri=${encodeURIComponent(uri)}`, granted: JSON.stringify(g), mode })}`);
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
      const line = await v.evaluate(() => ({ text: document.getElementById('status').textContent, shown: document.getElementById('status').checkVisibility(), error: document.getElementById('status').className === 'error', st: document.getElementById('st').checkVisibility() }));
      if (name === 'no-cors') check('connector no-cors: the reason is in Details', /error: .*(fetch|import|module)/i.test(st), st);
      check(`connector ${name}: the error the person must act on is on the status line, not only in Details (which stays closed)`, line.shown && line.error && !line.st
        && (name === 'no-cors' ? /^CLOADM could not start: .*open_emulator_inline/.test(line.text) : /different releases.*open_emulator_inline/.test(line.text)), JSON.stringify(line));
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
    const big = await v.evaluate(() => !document.getElementById('big').hidden);
    check(`connector ${name}: opened ${mode === 'inline' ? 'inline, ⋯ offers "Open in side panel"' : 'in the side panel (displayMode fullscreen), ⋯ does not offer it'}`, big === (mode === 'inline'));
    const storage = await v.evaluate(() => window.cloadmView.facts.storage);
    check(`connector ${name}: localStorage, IndexedDB and OPFS work in the view`, /localStorage ok, IndexedDB ok, OPFS ok/.test(storage), storage);
    if (shots) await page.screenshot({ path: path.join(shots, `connector-${name}.png`) });
    if (name === 'site') {
      // ROMs added in the panel (bytes standing in for a user's dump): kept in the panel's storage across a reload,
      // in another conversation's sandbox origin too (the partition is the chat's site); then no memory read leaves it
      const fake = (k) => Buffer.from(Uint8Array.from({ length: 16384 }, (_, i) => (i * 13 + k) & 255));
      await v.setInputFiles('#rom', [{ name: 'd64_1.rom', mimeType: 'application/octet-stream', buffer: fake(1) }, { name: 'd64_2.rom', mimeType: 'application/octet-stream', buffer: fake(2) }]);
      const took = await wait(v, () => window.cloadmView.session.machine.hasRom, null, 5000);
      await page.waitForTimeout(1000);   // (the stores write after the call)
      // another conversation: its view has another origin (Claude derives one per conversation and connector), so
      // its storage is its own
      await open('b');
      const other = await wait(page, () => window.hostT.listChanged, null, 20000) && await wait(view(), () => window.cloadmView && window.cloadmView.facts.storage !== '…', null, 10000);
      const otherRoms = other && await view().evaluate(() => window.cloadmView.session.machine.hasRom);
      await open('a');
      const again = await wait(page, () => window.hostT.listChanged, null, 20000);
      const v2 = view();
      const kept = again && await wait(v2, () => window.cloadmView && window.cloadmView.session.machine.hasRom, null, 10000);
      check('connector site: ROMs added in the panel are kept when the same conversation\'s view opens again; another conversation\'s view has its own storage', took && kept && other && otherRoms === false, JSON.stringify({ took, kept, other, otherRoms }));
      const withRoms = kept && await v2.evaluate(() => { document.getElementById('machine').click(); const tag = document.querySelector('#machine-menu [data-model="dragon64"] .tag').textContent; document.getElementById('machine').click(); return { tag, status: document.getElementById('status').textContent }; });
      check('connector site: with the ROMs, the Machine menu marks the model "✓ BASIC ready" and the status says BASIC runs', withRoms && withRoms.tag === '✓ BASIC ready' && withRoms.status === 'BASIC is running · Dragon 64 · your ROMs', JSON.stringify(withRoms));
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

// The view's own controls (R29), in the site variant (the same shell and panel.js as inline): the screen's fit inline
// (the host sizing the view from its content) and at a fixed height (the side panel) at 400, 600 and 900 px, the
// one-row toolbar, Details, ⋯'s "Open in side panel" by display mode, every Programs and Machine item, the menus from
// the keyboard, the sound switch, and Claude's chip: acting, reading, its keys, its announcement, never the person's.
async function uiScenario(browser, check, { shots = null } = {}) {
  const srv = await start();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  const g = { resourceDomains: [srv.site], connectDomains: [srv.site] };
  await page.goto(`http://claude.localhost:${srv.port}/?${new URLSearchParams({ w: 600, h: 300, proxy: `http://ui.sandbox.localhost:${srv.port}/sandbox?uri=${encodeURIComponent('ui://cloadm/panel.html')}`, granted: JSON.stringify(g) })}`);
  const view = () => page.frames().find((f) => f.url() === 'about:srcdoc');
  const call = (tool, args = {}) => page.evaluate(([n, a]) => window.callView('tools/call', { name: n, arguments: a }), [tool, args]);
  const shot = async (name) => { if (shots) await page.locator('iframe').contentFrame().locator('iframe').screenshot({ path: path.join(shots, `connector-ui-${name}.png`) }); };
  const settle = () => page.waitForTimeout(300);
  try {
    const up = await wait(page, () => window.hostT.listChanged, null, 30000);
    const v = view();
    check('connector ui: the view starts', up && await wait(v, () => window.cloadmView && window.cloadmView.facts.storage !== '…'), errors.join(' | '));
    const geometry = () => v.evaluate(() => {
      const c = document.getElementById('screen').getBoundingClientRect(), foot = document.getElementById('foot').getBoundingClientRect();
      return { vw: innerWidth, vh: innerHeight, cw: c.width, ch: c.height, left: c.left, top: c.top, bar: document.getElementById('bar').getBoundingClientRect().height,
        footTop: foot.top, footBottom: foot.bottom, doc: document.documentElement.scrollHeight, bezel: !!document.getElementById('screen').closest('#bezel') };
    });
    // ---- inline: the host sizes the view from its content (as an auto-sizing host does, here by hand): the screen
    // takes the full width at 4:3, and the height settles (it never feeds back into itself)
    const heights = [];
    for (let i = 0; i < 8; i++) {
      const h = (await geometry()).doc;
      heights.push(h);
      await page.evaluate((x) => window.resizeView(600, x), h);
      await page.waitForTimeout(120);
    }
    const in1 = await geometry();
    await page.waitForTimeout(1000);
    const in2 = await geometry();
    check('connector ui: inline (the host sizing the view from its content), the screen is 4:3 at the full width, and the height is stable for 1 s (no resize loop)',
      in1.bezel && Math.abs(in1.cw / in1.ch - 4 / 3) < 0.01 && (in1.vw - in1.cw) / 2 <= 16 && in1.doc === in2.doc && in1.ch === in2.ch && heights.slice(-3).every((h) => h === in2.doc),
      JSON.stringify({ heights, in1, in2 }));
    await shot('inline-600');
    // ---- Details: closed, every diagnostic hidden and the person reads one line; ⋯ → Details opens it
    const before = await v.evaluate(() => ({ open: document.getElementById('details').open, st: document.getElementById('st').checkVisibility(), msg: document.getElementById('msg').checkVisibility(), status: document.getElementById('status').textContent }));
    check('connector ui: Details is closed at first (the diagnostics and the raw load line hidden); the status line is one human line', !before.open && !before.st && !before.msg
      && before.status === 'LIZA is running · Dragon 64 · no ROMs', JSON.stringify(before));
    await v.click('#more'); await v.click('#details-item');
    const after = await v.evaluate(() => ({ open: document.getElementById('details').open, st: document.getElementById('st').checkVisibility(), text: document.getElementById('st').textContent, msg: document.getElementById('msg').textContent }));
    check('connector ui: ⋯ → Details opens every diagnostic (variant, host, mode, csp, storage, audio, bridge) and the raw load line', after.open && after.st
      && ['variant: site', 'host: host-stub', 'mode: inline', 'csp: resourceDomains', 'storage: localStorage ok', 'audio: off until a click', 'bridge: init', 'list_changed sent'].every((x) => after.text.includes(x)) && /liza\.bin: .*exec \$3000/.test(after.msg), JSON.stringify(after));
    await v.click('#more'); await v.click('#copy');
    await page.waitForTimeout(300);
    const copied = await v.evaluate(() => document.getElementById('status').textContent);
    check('connector ui: ⋯ → Copy details copies them', copied === 'Details copied.', copied);
    await v.click('#more'); await v.click('#details-item');
    // ---- the sound switch: "Sound off" until a click; the click is the gesture that starts the audio
    const sound = () => v.evaluate(() => { const b = document.getElementById('sound'); return { pressed: b.getAttribute('aria-pressed'), label: b.textContent, path: window.cloadmView.audio.path, on: window.cloadmView.audio.enabled }; });
    const s0 = await sound(); await v.click('#sound'); const s1 = await sound(); await v.click('#sound'); const s2 = await sound();
    check('connector ui: the sound switch says "Sound off" (aria-pressed false) until clicked; a click starts the audio (audio.path) and says "Sound on"; another turns it off',
      s0.pressed === 'false' && s0.label === 'Sound off' && s0.path === null && s1.pressed === 'true' && s1.label === 'Sound on' && !!s1.path && s1.on && s2.pressed === 'false' && s2.label === 'Sound off' && !s2.on, JSON.stringify([s0, s1, s2]));
    // ---- ⋯ → "Open in side panel": only inline with fullscreen offered; asked, the host answers and sends its new context
    const bigShown = async () => { await v.click('#more'); const r = await v.evaluate(() => document.getElementById('big').checkVisibility()); await page.keyboard.press('Escape'); return r; };
    // the host's notification alone (no request): fullscreen hides the item, inline brings it back
    await page.evaluate(() => window.hostContextChanged({ displayMode: 'fullscreen' }));
    await settle();
    const byNotice = await bigShown();
    await page.evaluate(() => window.hostContextChanged({ displayMode: 'inline' }));
    await settle();
    const offered = await bigShown();
    await v.click('#more'); await v.click('#big');
    await page.waitForTimeout(300);
    const asked = await page.evaluate(() => window.displayRequests), inSide = await bigShown(), sideMode = await v.evaluate(() => window.CLOADM_BRIDGE.hostContext.displayMode);
    check('connector ui: ⋯ offers "Open in side panel" inline (fullscreen available), not after the host\'s host-context-changed to fullscreen alone, asks the host, and does not offer it in the side panel',
      !byNotice && offered && JSON.stringify(asked) === '["fullscreen"]' && sideMode === 'fullscreen' && !inSide, JSON.stringify({ byNotice, offered, asked, inSide, sideMode }));
    // ---- a fixed height (the side panel): the screen fills the box left after the toolbar and one status line, in
    // the limiting dimension within 16 px; the toolbar is one row at every width
    const fixed = [];
    for (const [w, h] of [[400, 700], [600, 800], [900, 1000], [900, 560]]) {
      await page.evaluate(([a, b]) => { window.resizeView(a, b); window.hostContextChanged({ displayMode: 'fullscreen', containerDimensions: { width: a, height: b } }); }, [w, h]);
      await settle();
      const r = await geometry(), roomH = r.vh - r.bar - (r.footBottom - r.footTop);
      const gapW = (r.vw - r.cw) / 2, gapH = (roomH - r.ch) / 2;
      fixed.push(Object.assign({ w, h, gapW, gapH, ok: Math.abs(r.cw / r.ch - 4 / 3) < 0.01 && r.bar <= 44 && r.footBottom <= r.vh + 1 && gapW >= 0 && gapH >= 0 && Math.min(gapW, gapH) <= 13 }, r));   // the stage's 4 px and the bezel's 8 px, + 1
      if (h !== 560) await shot(`side-${w}`);
    }
    check('connector ui: in the side panel the screen fills the limiting dimension to the stage\'s and the bezel\'s padding (12 px, + 1) at 400, 600 and 900 px wide and at 900 x 560, 4:3, the status line in view, the toolbar one row (≤ 44 px)',
      fixed.every((f) => f.ok), JSON.stringify(fixed));
    await page.evaluate(() => { window.resizeView(600, 800); window.hostContextChanged({ displayMode: 'fullscreen', containerDimensions: { width: 600, height: 800 } }); });
    await settle();
    // ---- Programs: what this machine runs without ROMs, each item working; the Welcome menu's own keys work
    const pick = async (menuId, sel) => { await v.click(`#${menuId}`); await v.click(`#${menuId}-menu ${sel}`); await page.waitForTimeout(600); };
    const state = () => v.evaluate(() => ({ status: document.getElementById('status').textContent, screen: window.cloadmView.session.screenText().join('\n'), last: window.cloadmView.session.lastRun, model: window.cloadmView.session.machine.id, pc: window.cloadmView.session.machine.cpu.pc }));
    const listed = async () => { await v.click('#programs'); const r = await v.evaluate(() => [...document.querySelectorAll('#programs-menu [role="menuitem"]')].map((b) => b.dataset.program || b.dataset.action)); await page.keyboard.press('Escape'); return r; };
    const dragonList = await listed();
    const progs = {};
    for (const p of ['liza', 'demo', '2048', 'minesweeper', 'welcome']) { await pick('programs', `[data-program="${p}"]`); progs[p] = await state(); }
    await wait(v, () => /PRESS 1 TO 5/.test(window.cloadmView.session.screenText().join('\n')), null, 6000);
    progs.welcome = await state();
    check('connector ui: Programs lists what the Dragon 64 runs without ROMs (LIZA, the colour demo, 2048, Minesweeper, the Welcome menu, then Add ROMs for BASIC…), and each runs',
      JSON.stringify(dragonList) === '["liza","demo","2048","minesweeper","welcome","roms"]' && /LIZA - A DRAGON 64/.test(progs.liza.screen) && /^LIZA is running · Dragon 64/.test(progs.liza.status)
      && /^The colour demo is running/.test(progs.demo.status) && progs['2048'].last.name === '2048' && /^2048 is running/.test(progs['2048'].status)
      && progs.minesweeper.last.name === 'Minesweeper' && /^Minesweeper is running/.test(progs.minesweeper.status) && /PRESS 1 TO 5/.test(progs.welcome.screen),
      JSON.stringify({ dragonList, status: Object.values(progs).map((x) => x.status), welcome: progs.welcome.screen.replace(/\s+/g, ' ') }));
    await v.click('#screen'); await page.keyboard.press('1');
    await wait(v, () => /LIZA - A DRAGON/.test(window.cloadmView.session.screenText().join('\n')), null, 6000);
    const viaMenu = await state();
    check('connector ui: a choice typed in the Welcome menu runs (1: LIZA)', /LIZA - A DRAGON 64/.test(viaMenu.screen) && /^LIZA is running/.test(viaMenu.status), JSON.stringify(viaMenu).slice(0, 300));
    // ---- the menus from the keyboard (R16): ArrowDown opens on the first item, ArrowUp on the last; arrows, Home, End move; Escape closes back to the trigger; Enter picks
    await v.focus('#programs');
    await page.keyboard.press('ArrowDown');
    const first = await v.evaluate(() => [document.getElementById('programs').getAttribute('aria-expanded'), document.activeElement.dataset.program]);
    await page.keyboard.press('End'); const end = await v.evaluate(() => document.activeElement.dataset.action);
    await page.keyboard.press('Home'); const home = await v.evaluate(() => document.activeElement.dataset.program);
    await page.keyboard.press('Escape');
    const closed = await v.evaluate(() => [document.getElementById('programs-menu').hidden, document.getElementById('programs').getAttribute('aria-expanded'), document.activeElement.id]);
    await page.keyboard.press('ArrowUp'); const last = await v.evaluate(() => document.activeElement.dataset.action);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const kb = await state();
    check('connector ui: the menus work from the keyboard (aria-expanded; ArrowDown opens on the first item, ArrowUp on the last; Home, End; Escape back to the trigger; Enter picks the third: 2048)',
      JSON.stringify(first) === '["true","liza"]' && end === 'roms' && home === 'liza' && JSON.stringify(closed) === '[true,"false","programs"]' && last === 'roms' && kb.last.name === '2048', JSON.stringify({ first, end, home, closed, last, kb: kb.status }));
    // ---- Machine: every model switches, marked "needs ROMs" without them; then Reset, Switch off and on, Add ROMs…
    const ids = await v.evaluate(() => { document.getElementById('machine').click(); const r = [...document.querySelectorAll('#machine-menu [data-model]')].map((b) => [b.dataset.model, b.querySelector('.tag').textContent]); document.getElementById('machine').click(); return r; });
    await page.evaluate(() => window.resizeView(400, 720));
    await v.click('#machine'); await shot('machine-menu-400'); await page.keyboard.press('Escape');
    await page.evaluate(() => window.resizeView(600, 800));
    const switched = [];
    for (const [id] of ids) {
      await pick('machine', `[data-model="${id}"]`);
      const s2 = await state(), label = await v.evaluate(() => document.getElementById('screen').getAttribute('aria-label'));
      switched.push([id, s2.model === id && /Welcome menu is running · .* · no ROMs$/.test(s2.status) && label === `${s2.status.split(' · ')[1]} screen. Click or focus to type.`]);
    }
    const mc10 = await listed();
    const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).then(() => true, () => false);
    await pick('machine', '[data-action="roms"]');
    const chose = await chooser;
    await pick('machine', '[data-model="dragon64"]');
    await pick('programs', '[data-program="liza"]');
    await call('type_text', { machine_id: 'm1', text: 'HELLO\n' });
    await pick('machine', '[data-action="reset"]');
    const reset = await state();
    await pick('machine', '[data-action="power"]');
    const power = await state();
    check(`connector ui: Machine switches to each of the ${ids.length} models (marked "needs ROMs", the screen's label naming the model); Add ROMs… asks for files; Reset and Switch off and on work`,
      ids.length >= 17 && ids.every(([, t]) => t === 'needs ROMs') && switched.every(([, ok]) => ok) && chose && /^LIZA is running/.test(reset.status) && /LIZA - A DRAGON/.test(reset.screen) && !/> HELLO/.test(reset.screen)
      && /^Dragon 64 · no ROMs · Pick something from Programs, or ask Claude to play something\.$/.test(power.status), JSON.stringify({ switched: switched.filter(([, ok]) => !ok), chose, reset: reset.status, resetScreen: reset.screen.replace(/\s+/g, ' '), power: power.status }));
    check(`connector ui: on the ${ids[ids.length - 1][0]} (a 6803 machine, the last in the menu), Programs lists its own LIZA and Welcome menu, not the 6809 programs`,
      ['mc10', 'alice'].includes(ids[ids.length - 1][0]) && JSON.stringify(mc10) === '["liza","welcome","roms"]', JSON.stringify(mc10));
    // ---- the "Click to type" chip goes while the screen has focus
    await v.click('#programs'); await page.keyboard.press('Escape');
    const hintOff = await v.evaluate(() => document.getElementById('hint').checkVisibility());
    await v.click('#screen');
    const hintOn = await v.evaluate(() => document.getElementById('hint').checkVisibility());
    check('connector ui: "Click to type" shows on the bezel until the screen has focus', hintOff && !hintOn, JSON.stringify({ hintOff, hintOn }));
    // ---- Claude's chip. An acting call: the bezel in Claude's colour, "Claude is typing: " and the keys, one
    // announcement; after it, gone within 3 s and the status line keeps the action line
    await pick('programs', '[data-program="liza"]');
    const shown0 = await v.evaluate(() => window.cloadmView.cue.shown);
    // the chip sampled in the view every animation frame while the call runs; the person presses a key part way
    await v.evaluate(() => {
      window.samples = [];
      const el = (id) => document.getElementById(id);
      const look = () => { window.samples.push({ chip: el('chip').checkVisibility() ? el('chip').textContent : null, keys: el('chip-keys').textContent, claude: el('bezel').classList.contains('claude'), announce: el('announce').textContent }); if (window.samples.length < 400) requestAnimationFrame(look); };
      requestAnimationFrame(look);
    });
    await page.evaluate(() => { window.typed = window.callView('tools/call', { name: 'type_text', arguments: { machine_id: 'm1', text: 'I AM HAPPY TODAY, AND THE SUN IS OUT\n' } }); });
    await page.waitForTimeout(100);
    await v.focus('#screen'); await page.keyboard.press('X');   // the person types during Claude's call
    await page.evaluate(() => window.typed);
    const during = (await v.evaluate(() => window.samples)).filter((x) => x.chip && /^Claude is typing: /.test(x.chip));
    const all = await v.evaluate(() => window.samples.filter((x) => x.chip && !/^Claude typed /.test(x.chip)));
    const ended = await v.evaluate(() => ({ chip: document.getElementById('chip').textContent, status: document.getElementById('status').textContent, shown: window.cloadmView.cue.shown }));
    const gone = await wait(v, () => document.getElementById('chip').hidden && !document.getElementById('bezel').classList.contains('claude'), null, 3000);
    const kept = await v.evaluate(() => document.getElementById('status').textContent);
    const grew = during.map((d) => d.keys.length);
    check('connector ui: while Claude types, the bezel takes its colour and the chip says "Claude is typing: " with the keys, in its colour as they reach the machine; one announcement for the call',
      during.length >= 3 && all.every((d) => /^Claude is typing: /.test(d.chip) && d.claude) && grew.some((n, i) => i && n > grew[i - 1]) && new Set(during.map((d) => d.announce)).size === 1
      && during[0].announce === 'Claude is typing: I AM HAPPY TODAY, AND THE SUN IS OUT↵', JSON.stringify({ n: during.length, grew, first: during[0], other: all.filter((d) => !/^Claude is typing: /.test(d.chip)).slice(0, 3) }));
    check('connector ui: after the call: "Claude typed …" for 2 s, gone within 3 s; the status line keeps "Claude typed … · HH:MM"; the person\'s key during it added no chip',
      /^Claude typed …/.test(ended.chip) && ended.shown === shown0 + 1 && gone && /^Claude typed I AM HAPPY TODAY, AND THE SUN IS OUT↵ · \d\d:\d\d$/.test(kept), JSON.stringify({ ended, gone, kept }));
    // a reading call: a quiet chip, the bezel unchanged, the status line kept
    await call('peek', { machine_id: 'm1', address: 0x400, length: 8 });
    const read = await v.evaluate(() => ({ chip: document.getElementById('chip').checkVisibility() && document.getElementById('chip').textContent, cls: document.getElementById('chip').className, claude: document.getElementById('bezel').classList.contains('claude'), status: document.getElementById('status').textContent }));
    const readGone = await wait(v, () => document.getElementById('chip').hidden, null, 2500);
    check('connector ui: a peek shows the quiet "Claude read memory" chip for 1.5 s, without Claude\'s colour on the bezel', read.chip === 'Claude read memory' && read.cls.split(' ').includes('read') && !read.claude && readGone && read.status === kept, JSON.stringify(read));
    // the person's own typing: no chip, ever
    await v.click('#screen');
    const seen = [];
    for (const ch of 'HELLO') { await page.keyboard.press(ch); seen.push(await v.evaluate(() => document.getElementById('chip').hidden)); }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const own = await v.evaluate(() => ({ shown: window.cloadmView.cue.shown, hidden: document.getElementById('chip').hidden, claude: document.getElementById('bezel').classList.contains('claude'), screen: window.cloadmView.session.screenText().join('\n') }));
    check('connector ui: the person\'s own typing shows no chip and leaves the bezel as it is (and reaches LIZA)', seen.every(Boolean) && own.hidden && !own.claude && own.shown === ended.shown && /> X?HELLO/.test(own.screen), JSON.stringify({ seen, own: Object.assign(own, { screen: own.screen.slice(-200) }) }));
    // markup typed by Claude stays text in the chip
    const markup = '<b>X</b>&amp;';
    await call('type_text', { machine_id: 'm1', text: markup });
    const asText = await v.evaluate(() => ({ children: document.getElementById('chip-keys').childElementCount, text: document.getElementById('chip-keys').textContent, left: document.getElementById('chip-left').childElementCount }));
    check('connector ui: markup Claude types is shown as text in the chip (no elements made from it)', asText.children === 0 && asText.left === 0 && asText.text === markup, JSON.stringify(asText));
    // the announcement is short: a long text by its length; a loop of reads announces nothing
    await pick('programs', '[data-program="liza"]');
    const long = 'HELLO THERE '.repeat(25);
    await page.evaluate((t) => { window.longCall = window.callView('tools/call', { name: 'type_text', arguments: { machine_id: 'm1', text: t } }); }, long);
    await page.waitForTimeout(250);
    const longSaid = await v.evaluate(() => document.getElementById('announce').textContent);
    await shot('claude-typing');   // (while the call still runs)
    await page.evaluate(() => window.longCall);
    for (let i = 0; i < 6; i++) await call('screen_text', { machine_id: 'm1' });
    const afterReads = await v.evaluate(() => document.getElementById('announce').textContent);
    check('connector ui: one short announcement per acting call ("Claude is typing 300 characters" for a long text), and none for a loop of reads',
      longSaid === `Claude is typing ${long.length} characters` && afterReads === longSaid, JSON.stringify({ longSaid, afterReads }));
    // R34, Claude's colour, in the host's light and dark themes: a filled clay chip with near-black text (contrast
    // ≥ 4.5, keys included), always the word "Claude"; the bezel's clay edge with a #B85C3E outline on a light host
    // (≥ 3:1 against #FAF9F5); the focus ring neutral, never clay
    const colours = {};
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => window.hostContextChanged({ theme: t }), theme);
      await call('type_text', { machine_id: 'm1', text: 'OK\n' });
      colours[theme] = await v.evaluate(() => {
        const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const lum = (c) => { const [r, g, b] = rgb(c).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
        const el = (id) => document.getElementById(id), cs = (id) => getComputedStyle(el(id));
        const bg = cs('chip').backgroundColor;
        const bezel = cs('bezel');
        return { chip: el('chip').textContent, visible: el('chip').checkVisibility(), bg, text: ratio(cs('chip-text').color, bg), keys: ratio(cs('chip-keys').color, bg),
          outline: bezel.outlineStyle === 'solid' ? bezel.outlineColor : null, edge: bezel.outlineStyle === 'solid' ? ratio(bezel.outlineColor, 'rgb(250, 249, 245)') : null,
          glow: /217, 119, 87/.test(bezel.boxShadow) };
      });
      // the focus rings, reached from the keyboard (so :focus-visible holds): Sound → Tab → ⋯ → Tab → the screen
      await v.focus('#sound');
      await page.keyboard.press('Tab');
      const ring = await v.evaluate(() => { const e = document.activeElement; return { id: e.id, visible: e.matches(':focus-visible'), colour: getComputedStyle(e).outlineColor, style: getComputedStyle(e).outlineStyle }; });
      await page.keyboard.press('Tab');
      const screenRing = await v.evaluate(() => { const e = document.activeElement; return { id: e.id, visible: e.matches(':focus-visible'), shadow: getComputedStyle(e).boxShadow }; });
      const token = await v.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--focus').trim().toLowerCase());
      Object.assign(colours[theme], { ring, screenRing, token });
    }
    const clay = 'rgb(217, 119, 87)';
    const r34 = ['light', 'dark'].every((t) => {
      const c = colours[t];
      return c.visible && /Claude/.test(c.chip) && c.bg === clay && c.text >= 4.5 && c.keys >= 4.5 && c.glow
        && c.ring.id === 'more' && c.ring.visible && c.ring.style === 'solid' && c.ring.colour !== clay
        && c.screenRing.id === 'screen' && c.screenRing.visible && /rgb/.test(c.screenRing.shadow) && !/217, 119, 87/.test(c.screenRing.shadow)
        && c.token && c.token !== '#d97757'
        && (t === 'light' ? c.outline === 'rgb(184, 92, 62)' && c.edge >= 3 : c.outline === null);
    });
    check('connector ui: Claude\'s chip is filled clay with near-black text (≥ 4.5:1, its keys too) and says "Claude", in light and dark host themes; the bezel takes a clay edge (outlined #B85C3E, ≥ 3:1, on a light host); the focus ring is never clay',
      r34, JSON.stringify(colours));
    await page.evaluate(() => window.hostContextChanged({ theme: 'dark' }));
    check('connector ui: no page errors', !errors.length, errors.join(' | '));
  } finally {
    await ctx.close();
    srv.server.close();
    srv.server.closeAllConnections();
  }
}

// The view on a phone and as an auto-sizing host shows it inline:
//  * inline, the view reports its content's height (ui/notifications/size-changed) at three widths, and again when
//    the width changes; the host taking that height changes nothing more (no loop);
//  * on a touch screen in the side panel or fullscreen, the screen stays clear of the host's insets (safeAreaInsets),
//    or of the top reserve when the host gives none; the on-screen keys show (and not on a desktop), and a tap on a
//    key reaches the machine (screen_text, through the host, shows it); the Stick mode and BREAK once in each mode;
//  * a host that asks the person before each call: an approved call is answered, a denied one leaves the next working.
async function phoneScenario(browser, check, { shots = null } = {}) {
  const srv = await start();
  const g = { resourceDomains: [srv.site], connectDomains: [srv.site] };
  const url = (q) => `http://claude.localhost:${srv.port}/?${new URLSearchParams(Object.assign({ proxy: `http://ph.sandbox.localhost:${srv.port}/sandbox?uri=${encodeURIComponent('ui://cloadm/panel.html')}`, granted: JSON.stringify(g) }, q))}`;
  const errors = [];
  const opened = async (ctxOpts, q) => {
    const ctx = await browser.newContext(ctxOpts), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    await page.goto(url(q));
    const up = await wait(page, () => window.hostT.listChanged, null, 30000);
    const v = page.frames().find((f) => f.url() === 'about:srcdoc');
    const ready = up && await wait(v, () => window.cloadmView && window.cloadmView.facts.storage !== '…');
    return { ctx, page, v, ready };
  };
  const shot = async (page, name) => { if (shots) await page.locator('iframe').screenshot({ path: path.join(shots, `connector-phone-${name}.png`) }); };
  const text = async (page) => { const r = await page.evaluate(() => window.callView('tools/call', { name: 'screen_text', arguments: { machine_id: 'm1' } })); return r.result ? JSON.stringify(r.result.structuredContent) : ''; };
  try {
    // ---- inline, an auto-sizing desktop host: the height reported is the content's, at three widths, and again on resize
    {
      const { ctx, page, v, ready } = await opened({ viewport: { width: 1000, height: 1200 } }, { w: 320, h: 200, autosize: 1 });
      check('connector phone: the view starts (inline, auto-sizing host)', ready, errors.join(' | '));
      const at = [];
      for (const w of [320, 390, 600]) {
        await page.evaluate((x) => window.resizeView(x, parseInt(document.querySelector('iframe').style.height, 10)), w);
        await page.waitForTimeout(400);
        const n0 = await page.evaluate(() => window.sizes.length);
        await page.waitForTimeout(1000);
        const r = await page.evaluate(() => ({ n: window.sizes.length, last: window.sizes[window.sizes.length - 1], frame: document.querySelector('iframe').offsetHeight }));
        const content = await v.evaluate(() => ({ body: Math.ceil(document.body.getBoundingClientRect().height), vw: innerWidth, vh: innerHeight, cw: document.getElementById('screen').getBoundingClientRect().width, ch: document.getElementById('screen').getBoundingClientRect().height, keys: document.getElementById('keys').hidden }));
        at.push(Object.assign({ w, n0 }, r, content));
      }
      check('connector phone: inline, the view sends ui/notifications/size-changed with its content height at 320, 390 and 600 px wide (the body\'s height, the screen 4:3 at the full width), resent when the width changes, and steady once the host takes it',
        at.every((a, i) => a.last && a.last.height === a.body && a.last.width === a.w && a.frame === a.body && a.vh === a.body && Math.abs(a.cw / a.ch - 4 / 3) < 0.01 && a.w - a.cw <= 28 && a.n === a.n0 && a.keys && (i === 0 || a.last.height > at[i - 1].last.height)),
        JSON.stringify(at));
      const details = await v.evaluate(() => document.getElementById('st').textContent);
      check('connector phone: Details shows the size sent (size W×H ×n)', /size 600×\d+ ×\d+/.test(details), details.slice(-200));
      await ctx.close();
    }
    // ---- a phone (coarse pointer, touch), inline at 390 wide: the keys show, the host is told the taller height
    {
      const { ctx, page, v, ready } = await opened({ viewport: { width: 390, height: 1400 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, { w: 390, h: 200, autosize: 1 });
      await page.waitForTimeout(800);
      const r = await v.evaluate(() => ({ keys: !document.getElementById('keys').hidden, n: document.querySelectorAll('#keys .k').length, body: Math.ceil(document.body.getBoundingClientRect().height), hint: document.getElementById('hint').checkVisibility(), item: !document.getElementById('keys-item').hidden }));
      const last = await page.evaluate(() => window.sizes[window.sizes.length - 1]);
      check('connector phone: on a touch screen the on-screen keys show under the screen (and "Click to type" goes); inline the height reported includes them',
        ready && r.keys && r.n >= 48 && !r.hint && r.item && last && last.height === r.body, JSON.stringify({ ready, r, last }));
      await shot(page, 'inline-390');
      await ctx.close();
    }
    // ---- a phone in fullscreen, 390 x 844, the host reporting its insets: the toolbar and the screen below them
    for (const [name, extra, top] of [['insets', { safeAreaInsets: { top: 64, right: 0, bottom: 34, left: 0 }, platform: 'mobile' }, 64], ['reserve', {}, 56]]) {
      const { ctx, page, v, ready } = await opened({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, { w: 390, h: 844, mode: 'fullscreen', ctx: JSON.stringify(Object.assign({ containerDimensions: { width: 390, height: 844 } }, extra)) });
      await page.waitForTimeout(600);
      const geo = await v.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        return { vh: innerHeight, bar: r('bar').top, screen: r('screen').top, sb: r('screen').bottom, cw: r('screen').width, ch: r('screen').height, keysTop: r('keys').top, keysBottom: r('keys').bottom, foot: r('foot').bottom, keys: !document.getElementById('keys').hidden };
      });
      check(`connector phone: fullscreen at 390 x 844 with ${name === 'insets' ? 'the host\'s safeAreaInsets (top 64, bottom 34)' : 'no insets from the host: the top reserve (56 px)'}, the toolbar and the screen start below the inset, the keys and the status line end above the bottom one, the screen 4:3 and over 300 px wide`,
        ready && geo.keys && geo.bar >= top && geo.screen >= top && geo.sb <= geo.keysTop && geo.foot <= geo.vh - (name === 'insets' ? 34 : 0) + 1 && Math.abs(geo.cw / geo.ch - 4 / 3) < 0.01 && geo.cw > 300, JSON.stringify(geo));
      if (name === 'insets') {
        await shot(page, 'fullscreen-390x844');
        const sizesInFixed = await page.evaluate(() => window.sizes.length);
        check('connector phone: in fullscreen the view sends no size-changed (its size is the host\'s)', sizesInFixed === 0, String(sizesInFixed));
        // a tap on keys reaches the machine (LIZA): H, I, ENTER, through the touch screen
        const keys = page.frameLocator('iframe').frameLocator('iframe');
        for (const k of ['H', 'I', 'ENTER']) { await keys.locator(`#keys-full [data-key="${k}"]`).tap(); await page.waitForTimeout(150); }
        await page.waitForTimeout(500);
        const st = await text(page);
        check('connector phone: tapping H, I, ENTER on the on-screen keys types them into the machine (screen_text through the host shows "> HI")', /> HI/.test(st), st.slice(0, 400));
        // SHIFT is sticky for one key: SHIFT then 1 types "!", SHIFT lets go, and the next key is unshifted
        await keys.locator('#keys-full [data-key="SHIFT"]').tap();
        const armedShift = await v.evaluate(() => document.querySelector('#keys-full [data-key="SHIFT"]').getAttribute('aria-pressed'));
        for (const k of ['1', '2', 'ENTER']) { await keys.locator(`#keys-full [data-key="${k}"]`).tap(); await page.waitForTimeout(150); }
        await page.waitForTimeout(500);
        const shifted = await text(page);
        const afterShift = await v.evaluate(() => document.querySelector('#keys-full [data-key="SHIFT"]').getAttribute('aria-pressed'));
        check('connector phone: SHIFT is sticky for one key: SHIFT (pressed) then 1 types "!", SHIFT lets go, and the next key (2) is unshifted ("> !2")',
          armedShift === 'true' && afterShift === 'false' && /> !2(\s|\\n|")/.test(shifted), JSON.stringify({ armedShift, afterShift, shifted: shifted.slice(0, 500) }));
        // the three modes: Keys, Pad, Stick; in each exactly one BREAK showing, and it is the bottom row's
        const modeState = () => v.evaluate(() => {
          const vis = (sel) => [...document.querySelectorAll(sel)].filter((b) => b.checkVisibility());
          const br = vis('#keys [data-key="BREAK"]');
          return { mode: window.cloadmView.keys.mode, breaks: br.length, inBottom: br.every((b) => !!b.closest('#keys-bottom')), full: vis('#keys-full').length === 1,
            pad: vis('#keys-pad').length === 1, stick: vis('#keys-stick').length === 1, fire: vis('#keys-fire').length === 1, strip: vis('#keys-strip .k').map((b) => b.dataset.key || 'ABC'),
            sw: vis('#keys-mode button').map((b) => b.textContent) };
        });
        const modes = { keys: await modeState() };
        for (const m of ['pad', 'joystick']) { await keys.locator(`#keys-mode [data-mode="${m}"]`).tap(); await page.waitForTimeout(200); modes[m] = await modeState(); if (m === 'joystick') await shot(page, 'fullscreen-390x844-stick'); }
        const box = await keys.locator('#keys-fire').boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        const geo2 = await v.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return { sb: r('screen').bottom, keysTop: r('keys').top, foot: r('foot').bottom, vh: innerHeight, cw: r('screen').width }; });
        await keys.locator('#keys-mode [data-mode="keys"]').tap();
        check('connector phone: Keys | Pad | Stick: Keys the keyboard, Pad the D-pad, Stick the strip (SPACE ENTER 1 2 Y N ABC), the stick and FIRE; in each mode exactly one BREAK shows, in the bottom row; the screen refits above the keys',
          Object.values(modes).every((x) => x.breaks === 1 && x.inBottom && JSON.stringify(x.sw) === '["Keys","Pad","Stick"]')
          && modes.keys.full && !modes.keys.pad && modes.pad.pad && !modes.pad.full && !modes.pad.stick && modes.joystick.stick && modes.joystick.fire && !modes.joystick.full
          && JSON.stringify(modes.joystick.strip) === '["SPACE","ENTER","1","2","Y","N","ABC"]' && geo2.sb <= geo2.keysTop && geo2.foot <= geo2.vh - 33, JSON.stringify({ modes, geo2 }));
        // a shorter panel (390 x 640): the screen gives way, so the keys and the status line still fit above the bottom inset
        await page.evaluate(() => { window.resizeView(390, 640); window.hostContextChanged({ containerDimensions: { width: 390, height: 640 } }); });
        await page.waitForTimeout(400);
        const short = await v.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return { vh: innerHeight, screen: r('screen').top, sb: r('screen').bottom, keysTop: r('keys').top, foot: r('foot').bottom, cw: r('screen').width, ch: r('screen').height }; });
        check('connector phone: in a shorter panel (390 x 640) the screen shrinks so the keys and the status line still end above the bottom inset, below the top one',
          short.screen >= 64 && short.sb <= short.keysTop && short.foot <= short.vh - 34 + 1 && Math.abs(short.cw / short.ch - 4 / 3) < 0.01 && short.cw < 300, JSON.stringify(short));
        await page.evaluate(() => { window.resizeView(390, 844); window.hostContextChanged({ containerDimensions: { width: 390, height: 844 } }); });
        await page.waitForTimeout(300);
        // ⋯ hides them and brings them back
        await v.click('#more'); await v.click('#keys-item');
        const off = await v.evaluate(() => document.getElementById('keys').hidden);
        await v.click('#more'); await v.click('#keys-item');
        const back = await v.evaluate(() => !document.getElementById('keys').hidden);
        check('connector phone: ⋯ → Hide on-screen keys hides them, Show brings them back', off && back, JSON.stringify({ off, back }));
        // a host that asks the person first: the approved call is answered after the wait, a denied one changes nothing
        const approved = await page.evaluate(() => window.callApproved('type_text', { machine_id: 'm1', text: 'OK\n' }, { ms: 1500 }));
        const denied = await page.evaluate(() => window.callApproved('press_break', { machine_id: 'm1' }, { deny: true }));
        await page.waitForTimeout(400);
        const after = await text(page);
        const last = await v.evaluate(() => window.CLOADM_BRIDGE.log.last);
        check('connector phone: with a host that asks before each call, an approved call (after 1.5 s) is answered and acts, a denied one never reaches the view, and the next call works; Details names the last call',
          approved.result && !approved.result.isError && denied.denied && /> OK/.test(after) && /^screen_text ok \d+ ms$/.test(last), JSON.stringify({ approved: approved.result && approved.result.isError, last, after: after.slice(0, 300) }));
        // each program opens in the mode it is played with: 2048 the Pad, Minesweeper the Pad with F (Stick offered), LIZA the Keys
        const pickProgram = async (id) => { await v.click('#programs'); await v.click(`#programs-menu [data-program="${id}"]`); await page.waitForTimeout(700); return modeState(); };
        const extrasOf = () => v.evaluate(() => [...document.querySelectorAll('#keys-pad .kextras .k')].map((b) => b.dataset.key));
        const g2048 = await pickProgram('2048'), x2048 = await extrasOf();
        await shot(page, 'fullscreen-390x844-pad');
        // the Pad's arrows reach the game: SPACE (the Pad's) starts it, then each arrow that can move the tiles moves
        // them and adds one (a move that cannot changes nothing, so six moves in turn, and most must change the board)
        // (the board as drawn: a hash of the frame's pixels, since the tiles are graphics, not text)
        const board = () => v.evaluate(() => { const f = window.cloadmView.session.machine.render(), px = f.data; let h = 0; for (let i = 0; i < px.length; i++) h = (h * 31 + px[i]) | 0; return String(h); });
        // (only with the Pad up: without it the check below fails rather than the run stopping on a hidden key)
        const padUp = g2048.mode === 'pad';
        if (padUp) { await keys.locator('#keys-pad [data-key="SPACE"]').tap(); await page.waitForTimeout(500); }
        const b0 = await board(), seen = [];
        for (const k of padUp ? ['←', '↑', '→', '↓', '←', '↑'] : []) { await keys.locator(`#keys-pad [data-key="${k}"]`).tap(); await page.waitForTimeout(400); seen.push(await board()); }
        const moved = seen.filter((b, i) => b !== (i ? seen[i - 1] : b0)).length;
        const mines = await pickProgram('minesweeper'), xMines = await extrasOf();
        const liza = await pickProgram('liza');
        check('connector phone: a program opens in its own mode: 2048 on the Pad (no extras), Minesweeper on the Pad with F (Stick offered), LIZA on the Keys',
          g2048.mode === 'pad' && g2048.pad && JSON.stringify(x2048) === '[]' && mines.mode === 'pad' && JSON.stringify(xMines) === '["F"]' && mines.sw.includes('Stick') && liza.mode === 'keys' && liza.full,
          JSON.stringify({ g2048: g2048.mode, x2048, mines: mines.mode, xMines, sw: mines.sw, liza: liza.mode }));
        const padNames = await v.evaluate(() => [...document.querySelectorAll('#keys-pad .karrows .k')].map((b) => `${b.getAttribute('aria-label')}:${b.textContent}`));
        check('connector phone: the Pad\'s SPACE and arrows reach the game (2048 changes on at least four of ←, ↑, →, ↓, ←, ↑), each named by its direction (no DEL on the Pad\'s ←)',
          moved >= 4 && JSON.stringify(padNames) === '["Up:↑","Left:←","Down:↓","Right:→"]', JSON.stringify({ moved, padNames, seen }));
        // no Stick where the machine has no joystick port (the MC-10)
        await v.click('#machine'); await v.click('#machine-menu [data-model="mc10"]'); await page.waitForTimeout(700);
        const mc10 = await modeState();
        await v.click('#machine'); await v.click('#machine-menu [data-model="dragon64"]'); await page.waitForTimeout(700);
        await pickProgram('liza');
        check('connector phone: on the MC-10 (no joystick port) the switch is Keys | Pad, no Stick, and BREAK still shows once', JSON.stringify(mc10.sw) === '["Keys","Pad"]' && mc10.breaks === 1, JSON.stringify(mc10));
      }
      await ctx.close();
    }
    // ---- the choice is remembered per program: across a reload where the view's storage works; where it throws, for
    // the view's life only, and silently (no error), back to the program's own mode after a reload
    for (const broken of [false, true]) {
      const { ctx, page, v, ready } = await opened({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { w: 390, h: 844, mode: 'fullscreen', ctx: JSON.stringify({ containerDimensions: { width: 390, height: 844 } }) });
      // (a sandbox that refuses storage: every read and write throws, as Safari's does with storage blocked)
      if (broken) await ctx.addInitScript(() => { if (location.href === 'about:srcdoc') for (const f of ['getItem', 'setItem', 'removeItem']) Storage.prototype[f] = () => { throw new DOMException('storage is off', 'SecurityError'); }; });
      const keys = page.frameLocator('iframe').frameLocator('iframe');
      let view = v;
      if (broken) { await page.reload(); await wait(page, () => window.hostT.listChanged, null, 30000); view = page.frames().find((f) => f.url() === 'about:srcdoc'); await wait(view, () => window.cloadmView && window.cloadmView.facts.storage !== '…'); }
      const mode = () => view.evaluate(() => window.cloadmView.keys.mode);
      const pick = async (id) => { await view.click('#programs'); await view.click(`#programs-menu [data-program="${id}"]`); await page.waitForTimeout(600); };
      const errs0 = errors.length;
      await keys.locator('#keys-mode [data-mode="pad"]').tap();   // LIZA on the Pad
      await pick('2048'); const g = await mode();
      await pick('liza'); const kept = await mode();
      const stored = await view.evaluate(() => { try { return localStorage.getItem('cloadm.touchMode.dragon64.liza'); } catch (e) { return `throws ${e.name}`; } });
      await page.reload();
      await wait(page, () => window.hostT.listChanged, null, 30000);
      view = page.frames().find((f) => f.url() === 'about:srcdoc');
      await wait(view, () => window.cloadmView && window.cloadmView.facts.storage !== '…');
      await pick('liza');
      const reloaded = await mode();
      if (!broken) await keys.locator('#keys-mode [data-mode="keys"]').tap();   // (back to LIZA's own mode, for the next run)
      check(broken ? 'connector phone: with storage that throws, the choice (LIZA on the Pad) holds for the view\'s life, silently (no error), and after a reload LIZA is back on its own mode, the Keys'
        : 'connector phone: the choice is remembered per program: LIZA on the Pad, 2048 on its own Pad, LIZA still on the Pad, and after a reload of the view too (the view\'s storage)',
      ready && g === 'pad' && kept === 'pad' && (broken ? reloaded === 'keys' && /^throws SecurityError$/.test(stored) && errors.length === errs0 : reloaded === 'pad' && stored === 'pad'),
      JSON.stringify({ broken, g, kept, stored, reloaded, errors: errors.slice(errs0) }));
      await ctx.close();
    }
    // ---- a desktop: no keys
    {
      const { ctx, v, ready } = await opened({ viewport: { width: 800, height: 900 } }, { w: 600, h: 800, mode: 'fullscreen', ctx: JSON.stringify({ safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } }) });
      const r = await v.evaluate(() => ({ keys: document.getElementById('keys').hidden, item: document.getElementById('keys-item').hidden, bar: document.getElementById('bar').getBoundingClientRect().top }));
      check('connector phone: on a desktop (fine pointer, no touch) there are no on-screen keys and no ⋯ item for them; zero insets keep the toolbar at the top', ready && r.keys && r.item && r.bar === 0, JSON.stringify(r));
      await ctx.close();
    }
    check('connector phone: no page errors', !errors.length, errors.join(' | '));
  } finally {
    srv.server.close();
    srv.server.closeAllConnections();
  }
}

async function connectorChecks(browser, check, { shots = null } = {}) {
  await scenario(browser, check, 'site', { uri: 'ui://cloadm/panel.html', shots });
  await scenario(browser, check, 'inline', { uri: 'ui://cloadm/inline.html', granted: false, shots, mode: 'fullscreen' });
  await uiScenario(browser, check, { shots });
  await phoneScenario(browser, check, { shots });
  await scenario(browser, check, 'no-cors', { uri: 'ui://cloadm/panel.html', cors: false });
  await scenario(browser, check, 'out-of-step', { uri: 'ui://cloadm/panel.html', panelApi: 999 });
}
module.exports = { connectorChecks, uiScenario, phoneScenario, specCsp };

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
