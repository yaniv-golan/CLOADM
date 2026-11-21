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
f.style.cssText = \`width:\${q.get('w') || 680}px;height:\${q.get('h') || 620}px;border:0;display:block\`;
// the panel resized, and the host's context changing (displayMode: the side panel is 'fullscreen')
window.resizeView = (w, h) => { f.style.width = w + 'px'; f.style.height = h + 'px'; };
window.hostContextChanged = (params) => post({ method: 'ui/notifications/host-context-changed', params });
window.hostT = { created: Date.now() }; window.hostLists = []; window.hostLog = [];
let id = 1000; const waiting = new Map();
const post = (m) => f.contentWindow.postMessage(Object.assign({ jsonrpc: '2.0' }, m), '*');
window.callView = (method, params) => new Promise((ok) => { const i = id++; waiting.set(i, ok); post({ id: i, method, params }); });
const listTools = () => callView('tools/list', {}).then((r) => { hostLists.push(r.result ? r.result.tools.map((t) => t.name) : null); });
addEventListener('message', (e) => {
  const d = e.data; if (e.source !== f.contentWindow || !d || d.jsonrpc !== '2.0') return;
  hostLog.push(d.method || 'reply');
  if (d.method === 'ui/initialize') { hostT.initialize = Date.now(); post({ id: d.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'host-stub', version: '1' }, hostCapabilities: { sandbox: { csp: JSON.parse(q.get('granted') || '{}') } }, hostContext: { displayMode: q.get('mode') || 'inline', availableDisplayModes: ['inline', 'fullscreen'] } } }); }
  else if (d.method === 'ui/notifications/initialized') { hostT.initialized = Date.now(); listTools(); }
  else if (d.method === 'notifications/tools/list_changed') { hostT.listChanged = Date.now(); listTools(); }
  else if (d.method === 'ui/request-display-mode') { window.displayRequests = (window.displayRequests || []).concat([d.params.mode]); post({ id: d.id, result: { mode: 'fullscreen' } }); }
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
    const big = await v.evaluate(() => document.getElementById('big').checkVisibility());
    check(`connector ${name}: opened ${mode === 'inline' ? 'inline, the view offers "Open in side panel"' : 'in the side panel (displayMode fullscreen), it does not offer it'}`, big === (mode === 'inline'));
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
      check('connector site: with the ROMs, the Machine menu marks the model BASIC and the status says BASIC runs', withRoms && withRoms.tag === 'BASIC' && withRoms.status === 'BASIC is running on the Dragon 64, with your ROMs.', JSON.stringify(withRoms));
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

// The view's own controls, in the site variant (the same shell and panel.js as inline): Details, the screen's fit at
// panel widths, the side-panel button by display mode, every Programs and Machine item, the sound switch, the menus
// from the keyboard, and the cue that Claude is driving (never for the person's own keys).
async function uiScenario(browser, check, { shots = null } = {}) {
  const srv = await start();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  const g = { resourceDomains: [srv.site], connectDomains: [srv.site] };
  await page.goto(`http://claude.localhost:${srv.port}/?${new URLSearchParams({ w: 400, h: 720, proxy: `http://ui.sandbox.localhost:${srv.port}/sandbox?uri=${encodeURIComponent('ui://cloadm/panel.html')}`, granted: JSON.stringify(g) })}`);
  const view = () => page.frames().find((f) => f.url() === 'about:srcdoc');
  const call = (tool, args = {}) => page.evaluate(([n, a]) => window.callView('tools/call', { name: n, arguments: a }), [tool, args]);
  const viewFrame = async () => page.locator('iframe').contentFrame().locator('iframe');
  try {
    const up = await wait(page, () => window.hostT.listChanged, null, 30000);
    const v = view();
    check('connector ui: the view starts', up && await wait(v, () => window.cloadmView && window.cloadmView.facts.storage !== '…'), errors.join(' | '));
    // ---- Details: collapsed, the person sees a friendly status; open, every diagnostic is there
    const before = await v.evaluate(() => ({ open: document.getElementById('details').open, st: document.getElementById('st').checkVisibility(), msg: document.getElementById('msg').checkVisibility(), status: document.getElementById('status').textContent }));
    await v.click('#details summary');
    const after = await v.evaluate(() => ({ open: document.getElementById('details').open, st: document.getElementById('st').checkVisibility(), text: document.getElementById('st').textContent, msg: document.getElementById('msg').textContent }));
    check('connector ui: Details is collapsed at first (the diagnostics and the raw load line hidden); the status says what runs', !before.open && !before.st && !before.msg && /^LIZA is running on the Dragon 64\.$/.test(before.status), JSON.stringify(before));
    check('connector ui: Details opens to every diagnostic (variant, host, mode, csp, storage, audio, bridge) and the raw load line', after.open && after.st
      && ['variant: site', 'host: host-stub', 'mode: inline', 'csp: resourceDomains', 'storage: localStorage ok', 'audio: off until a click', 'bridge: init', 'list_changed sent'].every((x) => after.text.includes(x)) && /liza\.bin: .*exec \$3000/.test(after.msg), JSON.stringify(after));
    await v.click('#details summary');
    // ---- the sound switch: off until a click, on, off
    const sound = () => v.evaluate(() => ({ pressed: document.getElementById('sound').getAttribute('aria-pressed'), title: document.getElementById('sound').title, ctx: !!window.cloadmView.audio.ctx, on: window.cloadmView.audio.enabled }));
    const s0 = await sound();
    await v.click('#sound'); const s1 = await sound();
    await v.click('#sound'); const s2 = await sound();
    check('connector ui: the sound switch shows "off until you click", turns sound on (the audio starts), then off', s0.pressed === 'false' && /until you click/.test(s0.title) && !s0.ctx
      && s1.pressed === 'true' && s1.ctx && s1.on && s2.pressed === 'false' && !s2.on, JSON.stringify([s0, s1, s2]));
    // ---- the screen fills the panel, 4:3, at each width; and fits the height when that is what limits it
    const fits = [];
    for (const [w, h] of [[400, 720], [600, 820], [900, 1020], [900, 520]]) {
      await page.evaluate(([a, b]) => window.resizeView(a, b), [w, h]);
      await page.waitForTimeout(400);
      const r = await v.evaluate(() => {
        const c = document.getElementById('screen').getBoundingClientRect(), foot = document.getElementById('foot').getBoundingClientRect();
        return { vw: innerWidth, vh: innerHeight, cw: c.width, ch: c.height, footBottom: foot.bottom, bar: document.getElementById('bar').offsetHeight, foot: foot.height, bezel: !!document.getElementById('screen').closest('#bezel') };
      });
      // the room for the picture: the view less the stage's and the bezel's padding (36 across, 32 down), the toolbar and the status line
      const room = { w: r.vw - 36, h: r.vh - r.bar - r.foot - 32 };
      fits.push(Object.assign({ w, h, ok: r.bezel && Math.abs(r.cw / r.ch - 4 / 3) < 0.01 && r.cw <= room.w + 1 && r.ch <= room.h + 1 && r.footBottom <= r.vh + 1 && (r.cw >= 0.9 * room.w || r.ch >= 0.9 * room.h) }, r));
      if (shots && h > 600) await (await viewFrame()).screenshot({ path: path.join(shots, `connector-ui-${w}.png`) });
    }
    check('connector ui: the screen, in its bezel, fills the panel 4:3 at 400, 600 and 900 px wide (the width), and at 900 x 520 (the height), with the status line still in view', fits.every((f) => f.ok)
      && fits.filter((f) => f.h > 600).every((f) => f.cw >= 0.85 * f.vw), JSON.stringify(fits));
    await page.evaluate(() => window.resizeView(600, 820));
    // ---- the side-panel button: shown inline, hidden in the side panel (displayMode fullscreen), by context and by request
    const big = () => v.evaluate(() => document.getElementById('big').checkVisibility());
    const inline1 = await big();
    await page.evaluate(() => window.hostContextChanged({ displayMode: 'fullscreen' }));
    await page.waitForTimeout(200);
    const side = await big(), sideFits = await v.evaluate(() => document.getElementById('foot').getBoundingClientRect().bottom <= innerHeight + 1);
    await page.evaluate(() => window.hostContextChanged({ displayMode: 'inline' }));
    await page.waitForTimeout(200);
    const inline2 = await big();
    await v.click('#big');
    await page.waitForTimeout(300);
    const asked = await page.evaluate(() => window.displayRequests), afterAsk = await big();
    check('connector ui: "Open in side panel" shows inline, hides in the side panel (host-context-changed), shows again inline, and asks for it (then hides)',
      inline1 && !side && sideFits && inline2 && JSON.stringify(asked) === '["fullscreen"]' && !afterAsk, JSON.stringify({ inline1, side, sideFits, inline2, asked, afterAsk }));
    await page.evaluate(() => window.hostContextChanged({ displayMode: 'inline' }));
    // ---- Programs: each item runs its program
    const pick = async (menuId, sel) => { await v.click(`#${menuId}`); await v.click(`#${menuId}-menu ${sel}`); await page.waitForTimeout(700); };
    const state = () => v.evaluate(() => ({ status: document.getElementById('status').textContent, screen: window.cloadmView.session.screenText().join('\n'), last: window.cloadmView.session.lastRun, model: window.cloadmView.session.machine.id }));
    const progs = {};
    for (const p of ['welcome', 'liza', '2048', 'minesweeper']) { await pick('programs', `[data-program="${p}"]`); progs[p] = await state(); }
    check('connector ui: Programs runs the Welcome menu, LIZA, 2048 and Minesweeper', /PRESS 1 TO 5/.test(progs.welcome.screen) && /Welcome menu is running/.test(progs.welcome.status)
      && /LIZA - A DRAGON 64/.test(progs.liza.screen) && /^LIZA is running/.test(progs.liza.status)
      && progs['2048'].last.name === '2048' && /^2048 is running/.test(progs['2048'].status) && progs.minesweeper.last.name === 'Minesweeper' && /^Minesweeper is running/.test(progs.minesweeper.status), JSON.stringify(progs).slice(0, 600));
    // the Welcome menu's own keys work in the panel (2: the colour demo? 1: LIZA)
    await pick('programs', '[data-program="welcome"]');
    await v.click('#screen'); await page.keyboard.press('1');
    await wait(v, () => /LIZA - A DRAGON/.test(window.cloadmView.session.screenText().join('\n')), null, 6000);
    const viaMenu = await state();
    check('connector ui: a choice typed in the Welcome menu runs (1: LIZA)', /LIZA - A DRAGON 64/.test(viaMenu.screen) && /^LIZA is running/.test(viaMenu.status), JSON.stringify(viaMenu).slice(0, 300));
    // ---- the menus from the keyboard: ArrowDown opens on the first item, ArrowDown moves, Enter picks; Escape closes and gives the focus back
    await v.focus('#programs');
    await page.keyboard.press('ArrowDown');
    const first = await v.evaluate(() => [document.getElementById('programs').getAttribute('aria-expanded'), document.activeElement.dataset.program]);
    await page.keyboard.press('Escape');
    const closed = await v.evaluate(() => [document.getElementById('programs-menu').hidden, document.activeElement.id]);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const kb = await state();
    check('connector ui: the menus work from the keyboard (ArrowDown opens on the first item, Escape closes back to the button, Enter picks the third: 2048)',
      JSON.stringify(first) === '["true","welcome"]' && JSON.stringify(closed) === '[true,"programs"]' && kb.last.name === '2048', JSON.stringify({ first, closed, kb: kb.status }));
    // ---- Machine: every model switches; the ones without ROMs say so; the last item asks for ROMs
    const ids = await v.evaluate(async () => { document.getElementById('machine').click(); const r = [...document.querySelectorAll('#machine-menu [data-model]')].map((b) => [b.dataset.model, b.querySelector('.tag').textContent]); document.getElementById('machine').click(); return r; });
    if (shots) { await page.evaluate(() => window.resizeView(400, 720)); await v.click('#machine'); await (await viewFrame()).screenshot({ path: path.join(shots, 'connector-ui-machine-menu.png') }); await v.click('#machine'); await page.evaluate(() => window.resizeView(600, 820)); }
    const switched = [];
    for (const [id] of ids) {
      await pick('machine', `[data-model="${id}"]`);
      const s2 = await state(), checked = await v.evaluate((x) => { document.getElementById('machine').click(); const c = document.querySelector('#machine-menu [aria-checked="true"]').dataset.model; document.getElementById('machine').click(); return c === x; }, id);
      switched.push([id, s2.model === id && checked && /built-in firmware|Welcome menu is running/.test(s2.status)]);
    }
    const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).then(() => true, () => false);
    await pick('machine', '[data-action="roms"]');
    check(`connector ui: Machine switches to each of the ${ids.length} models (marked "no ROMs" without them), and its last item asks for ROMs`,
      ids.length >= 17 && ids.every(([, t]) => t === 'no ROMs') && switched.every(([, ok]) => ok) && await chooser, JSON.stringify({ ids, switched }));
    await pick('machine', '[data-model="dragon64"]');
    // ---- Claude's cue: on a call that types, with the keys; not on one that reads; never on the person's own keys
    await pick('programs', '[data-program="liza"]');
    const shown0 = await v.evaluate(() => window.cloadmView.cue.shown);
    await call('screen_text', { machine_id: 'm1' });
    const afterRead = await v.evaluate(() => [window.cloadmView.cue.shown, document.getElementById('activity').hidden]);
    await call('type_text', { machine_id: 'm1', text: 'I AM HAPPY\n' });
    const cue = await v.evaluate(() => ({ hidden: document.getElementById('activity').hidden, text: document.getElementById('activity').textContent, shown: window.cloadmView.cue.shown }));
    if (shots) await (await viewFrame()).screenshot({ path: path.join(shots, 'connector-ui-claude.png') });
    const faded = await wait(v, () => document.getElementById('activity').hidden, null, 4000);
    check('connector ui: a type_text call from Claude shows "Claude is typing" and the keys, a read shows nothing, and the cue fades after',
      afterRead[0] === shown0 && afterRead[1] && !cue.hidden && /Claude\s*is typing\s*I AM HAPPY⏎/.test(cue.text) && cue.shown === shown0 + 1 && faded, JSON.stringify({ shown0, afterRead, cue, faded }));
    await v.click('#screen');
    const seen = [];
    for (const ch of 'HELLO') { await page.keyboard.press(ch); seen.push(await v.evaluate(() => document.getElementById('activity').hidden)); }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const own = await v.evaluate(() => ({ shown: window.cloadmView.cue.shown, hidden: document.getElementById('activity').hidden, screen: window.cloadmView.session.screenText().join('\n') }));
    check('connector ui: the person\'s own typing shows no cue (and reaches LIZA)', seen.every(Boolean) && own.hidden && own.shown === cue.shown && /> HELLO/.test(own.screen), JSON.stringify({ seen, own: Object.assign(own, { screen: own.screen.slice(-200) }) }));
    // reduced motion: the cue goes without fading
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await v.evaluate(() => { window.fadedOnce = false; new MutationObserver(() => { if (document.getElementById('activity').classList.contains('fading')) window.fadedOnce = true; }).observe(document.getElementById('activity'), { attributes: true }); });
    await call('press_keys', { machine_id: 'm1', keys: ['SPACE'], frames: 2 });
    const gone = await wait(v, () => document.getElementById('activity').hidden, null, 4000);
    await page.waitForTimeout(600);
    const fadedOnce = await v.evaluate(() => window.fadedOnce);
    check('connector ui: with reduced motion the cue goes without the fade', gone && fadedOnce === false, JSON.stringify({ gone, fadedOnce }));
    check('connector ui: no page errors', !errors.length, errors.join(' | '));
  } finally {
    await ctx.close();
    srv.server.close();
    srv.server.closeAllConnections();
  }
}

async function connectorChecks(browser, check, { shots = null } = {}) {
  await scenario(browser, check, 'site', { uri: 'ui://cloadm/panel.html', shots });
  await scenario(browser, check, 'inline', { uri: 'ui://cloadm/inline.html', granted: false, shots, mode: 'fullscreen' });
  await uiScenario(browser, check, { shots });
  await scenario(browser, check, 'no-cors', { uri: 'ui://cloadm/panel.html', cors: false });
  await scenario(browser, check, 'out-of-step', { uri: 'ui://cloadm/panel.html', panelApi: 999 });
}
module.exports = { connectorChecks, uiScenario, specCsp };

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
