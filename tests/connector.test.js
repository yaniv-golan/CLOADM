// The side-panel connector (connector/), without a browser:
//  * the Worker (connector/worker/src/server.js) over Streamable HTTP as Claude calls it: initialize, tools/list (two
//    tools, each with its ui:// view), tools/call, resources/list and resources/read (the MCP Apps MIME type, the CSP:
//    variant A declares https://cloadm.dev only, B nothing), notifications (202), GET (405), bad bodies; it writes no
//    console output; wrangler.toml holds no secret, no account and keeps logs off;
//  * the views (connector/build.js): A fetches one module, from cloadm.dev; B fetches nothing and carries the bundled
//    programs; both carry the tool list and PANEL_API; the version is the checkout's `git describe`; the build refuses
//    a site whose PANEL_API differs (checkSite);
//  * the folded core (connector/fold.js) runs LIZA identically to the plain modules (screen, frame count, every pixel),
//    and the folded panel toolbox lists the same tools;
//  * the panel's tools (connector/view/tools.js): the local server's names and schemas, byte for byte; the file tools
//    left out; results over 100,000 characters refused; every bundled program file a model can ask for is carried;
//  * the bridge (connector/view/bridge.js) in a vm, playing the host: ui/initialize is sent as the script runs, before
//    the emulator exists; tools/list is answered at once; an early call waits for the emulator; list_changed follows
//    attach; a mismatched PANEL_API is out-of-step, a failed start not-started; a cancelled call gets no reply.
// The browser check's `connector` group runs both views in Chromium under the spec's CSP (tools/connector-check.js).
// Run: node tests/connector.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

let fail = 0, n = 0;
process.exitCode = 1;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;

(async () => {
  const build = await imp('connector/build.js');
  const { createServer, ORIGIN, MIME } = await imp('connector/worker/src/server.js');
  const panel = await imp('connector/view/tools.js');
  const T = await imp('js/mcp/tools.js');
  const { Session } = await imp('js/session.js');
  const { profiles } = await imp('js/machines/profiles.js');
  const { GAMES } = await imp('js/session.js');
  const views = build.views();

  // ---------------- the Worker ----------------
  const logged = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => logged.push(a); }
  const worker = createServer(views);
  const post = async (body, raw) => {
    const r = await worker.fetch(new Request('https://mcp.cloadm.dev/mcp', { method: 'POST', body: raw != null ? raw : J(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }));
    const t = await r.text();
    return { status: r.status, type: r.headers.get('content-type'), body: t ? JSON.parse(t) : null };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const initOld = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  const notif = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const calls = await Promise.all(['open_emulator', 'open_emulator_inline'].map((name) => post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } })));
  const unknown = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'type_text', arguments: {} } });
  const rlist = await post({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  const read = async (uri) => (await post({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri } })).body;
  const A = (await read('ui://cloadm/panel.html')).result.contents[0], B = (await read('ui://cloadm/inline.html')).result.contents[0];
  const noRes = await read('ui://cloadm/nope.html');
  const batch = await post([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]);
  // a batch of reads of the 1 MiB view (57 KB of request asking for about 600 MiB of reply) is refused unread
  const bomb = await post(Array.from({ length: 600 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'resources/read', params: { uri: 'ui://cloadm/inline.html' } })));
  // the body limit is in bytes, not characters: 30,000 three-byte characters are 90,000 bytes
  const wide = await post(null, J({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: '\u20ac'.repeat(30000) } }));
  const lied = await worker.fetch(new Request('https://mcp.cloadm.dev/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'content-length': '999999' } }));
  const get = await worker.fetch(new Request('https://mcp.cloadm.dev/mcp'));
  const other = await worker.fetch(new Request('https://mcp.cloadm.dev/'));
  const parse = await post(null, '{nope');
  const invalid = await post({ id: 1, method: 'ping' });
  const big = await post(null, J({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70000) } }));
  const method = await post({ jsonrpc: '2.0', id: 8, method: 'prompts/list' });
  for (const k of Object.keys(saved)) console[k] = saved[k];

  // git as the build runs it; null where it cannot answer (no git binary, or not a checkout: a source archive)
  const git = (args) => {
    try { return require('child_process').execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; }
  };
  const inCheckout = git(['rev-parse', 'HEAD']) !== null;
  check('initialize: the client\'s version when the Worker speaks it, else the newest; the MCP Apps extension; the release version',
    init.body.result.protocolVersion === '2025-06-18' && initOld.body.result.protocolVersion === '2025-11-25'
    && J(init.body.result.capabilities.extensions['io.modelcontextprotocol/ui'].mimeTypes) === J([MIME])
    && init.body.result.serverInfo.version === build.version() && (build.version() !== 'unknown') === inCheckout && /next message/.test(init.body.result.instructions), J(init.body));
  check('a notification gets 202 and no body', notif.status === 202 && notif.body === null);
  check('a batch (a JSON array) is refused with -32600, also one of 600 reads of the 1 MiB view (nothing is built)', batch.status === 400 && batch.body.error.code === -32600 && /batches/.test(batch.body.error.message)
    && bomb.status === 400 && bomb.body.error.code === -32600 && J(bomb.body).length < 200, J(batch.body));
  check('the 64 KiB limit counts bytes (90,000 bytes of 30,000 characters: 413), and a Content-Length over it is refused before reading', wide.status === 413 && lied.status === 413, `${wide.status} ${lied.status}`);
  const tools = list.body.result.tools;
  check('tools/list: the two server tools, each opening its view, no arguments, read-only',
    J(tools.map((t) => [t.name, t._meta.ui.resourceUri])) === J([['open_emulator', 'ui://cloadm/panel.html'], ['open_emulator_inline', 'ui://cloadm/inline.html']])
    && tools.every((t) => t.inputSchema.type === 'object' && J(t.inputSchema.properties) === '{}' && t.annotations.readOnlyHint), J(tools).slice(0, 300));
  check('tools/call: says the app tools come in the next message, on machine m1', calls.every((c) => /next message/.test(c.body.result.content[0].text) && /"m1"/.test(c.body.result.content[0].text)));
  check('tools/call: the app tools are not server tools', unknown.body.error.code === -32602);
  check('resources: both views, as MCP Apps HTML', J(rlist.body.result.resources.map((r) => [r.uri, r.mimeType])) === J([['ui://cloadm/panel.html', MIME], ['ui://cloadm/inline.html', MIME]])
    && A.mimeType === MIME && B.mimeType === MIME && A.text === views.site && B.text === views.inline && noRes.error.code === -32602);
  check('CSP: variant A declares https://cloadm.dev and nothing else; B declares none', ORIGIN === 'https://cloadm.dev'
    && J(A._meta.ui.csp) === J({ resourceDomains: ['https://cloadm.dev'], connectDomains: ['https://cloadm.dev'] }) && B._meta.ui.csp === undefined, J([A._meta, B._meta]));
  check('HTTP: GET 405, other paths 404, a parse error 400, a non-JSON-RPC body 400, a body over 64 KiB 413, an unknown method -32601',
    get.status === 405 && get.headers.get('allow') === 'POST' && other.status === 404 && parse.status === 400 && parse.body.error.code === -32700
    && invalid.status === 400 && big.status === 413 && method.body.error.code === -32601);
  check('the Worker writes nothing to the console (no request is logged)', logged.length === 0, J(logged).slice(0, 200));
  const workerSrc = ['server.js', 'index.js'].map((f) => fs.readFileSync(path.join(ROOT, 'connector/worker/src', f), 'utf8')).join('\n');
  const toml = fs.readFileSync(path.join(ROOT, 'connector/worker/wrangler.toml'), 'utf8');
  check('no logging, no storage, no secret: no console in the source; wrangler.toml has logs off and no account, vars, KV or secrets',
    !/console\.|caches\.|\.put\(/.test(workerSrc) && /\[observability\]\s*\nenabled = false/.test(toml) && !/account_id|\[vars\]|kv_namespaces|secret|token/i.test(toml.replace(/^#.*$/gm, ''))
    && /command = "node \.\.\/build\.js"/.test(toml), toml);
  check('the generated views are not committed', fs.readFileSync(path.join(ROOT, 'connector/worker/.gitignore'), 'utf8').split('\n').includes('src/views.gen.js'));

  // ---------------- the views ----------------
  const cfgOf = (html) => JSON.parse(/<script>globalThis\.CLOADM_VIEW = (.*);<\/script>/.exec(html)[1]);
  const cfgA = cfgOf(views.site), cfgB = cfgOf(views.inline);
  const fetched = (html) => [...html.matchAll(/\bimport\s*\(\s*("[^"]*"|'[^']*')/g)].map((m) => JSON.parse(m[1].replace(/^'|'$/g, '"')));
  check('A: the only thing it fetches is panel.js from cloadm.dev (which brings js/ from beside it); no src or href',
    J(fetched(views.site)) === J(['https://cloadm.dev/connector/view/panel.js']) && !/\s(src|href)\s*=/i.test(views.site.replace(/<script>[\s\S]*?<\/script>/g, '')), J(fetched(views.site)));
  check('B: nothing to fetch (no import, no src); the bundled programs inline', !/\bfrom\s*'(\.|https?:)|\bimport\s*\(|<script[^>]*\bsrc=/.test(views.inline)
    && J(Object.keys(cfgB.programs)) === J(panel.PROGRAM_FILES) && panel.PROGRAM_FILES.every((f) => cfgB.programs[f] === fs.readFileSync(path.join(ROOT, 'examples', f)).toString('base64')));
  check('both: the bridge before the emulator, PANEL_API and the version in CLOADM_VIEW, the tool list as the panel lists it',
    [views.site, views.inline].every((h) => h.indexOf('CLOADM_BRIDGE = {') < h.indexOf('<script type="module">')) && cfgA.api === panel.PANEL_API && cfgB.api === panel.PANEL_API
    && cfgA.version === build.version() && J(cfgA.tools) === J(build.panelTools()) && J(cfgB.tools) === J(cfgA.tools) && cfgA.programs === undefined);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const describedRaw = git(['describe', '--tags', '--always', '--dirty']);
  if (describedRaw === null) {
    // without git the build cannot know what it is, and says so rather than borrowing the released number
    check('the version without git is "unknown", not the released number in CHANGELOG.md or the manifests',
      build.version() === 'unknown' && build.version() !== manifest.version, `${build.version()} ${manifest.version}`);
  } else {
    const described = describedRaw.trim().replace(/^v/, '');
    const tags = (git(['tag', '--points-at', 'HEAD']) || '').split('\n');
    check('the version is the build\'s (git describe), not the released number in CHANGELOG.md or the manifests', build.version() === described
      && (tags.includes(`v${manifest.version}`) || build.version() !== manifest.version), `${build.version()} ${described} ${manifest.version}`);
  }
  const site = (body) => async () => body;
  const same = await build.checkSite(site(`export const PANEL_API = ${panel.PANEL_API};`));
  const otherApi = await build.checkSite(site(`export const PANEL_API = ${panel.PANEL_API + 1};`));
  const missing = await build.checkSite(async () => { throw new Error('HTTP 404'); });
  const none = await build.checkSite(site('// not the panel'));
  check('build: the site check passes only when cloadm.dev serves the same PANEL_API (a release not yet on the site is refused)', same.ok && !otherApi.ok && /serves PANEL_API/.test(otherApi.why)
    && !missing.ok && /404/.test(missing.why) && !none.ok, J([otherApi, missing, none]));
  check('B is about 1 MiB (claude.ai has accepted a 909 KiB view)', views.inline.length < 1.25 * 1024 * 1024, `${views.inline.length}`);

  // ---------------- the folded core ----------------
  const { fold } = await imp('connector/fold.js');
  const loadFolded = async (entry, tail) => import('data:text/javascript;base64,' + Buffer.from(fold(path.resolve(ROOT, entry), { tail }).code).toString('base64'));
  const liza = fs.readFileSync(path.join(ROOT, 'examples/liza.bin'));
  async function run(S) {
    const s = new S({ welcomeMenu: false }); await s.ready();
    s.switchMachine('dragon64', undefined, { menu: false });
    s.runLiza(liza);
    s.runFrames(100);
    s.typeText('I AM HAPPY\n');
    s.runFrames(400);
    const f = s.shownMachine.render();
    return { text: s.screenText().join('\n'), frames: s.shownMachine.frameCount, pixels: Buffer.from(f.data).toString('base64') };
  }
  const folded = await run((await loadFolded('js/session.js', 'export const Session = __ENTRY__.Session;\n')).Session);
  const plain = await run(Session);
  check('fold: the folded emulator runs LIZA identically to the plain modules (screen, frames, every pixel)', /> I AM HAPPY/.test(plain.text) && J(folded) === J(plain), plain.text);
  // an entry that brings the panel toolbox and the Session class it checks for, from the same folded graph
  const entry = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'cloadm-fold-')), 'entry.js');
  fs.writeFileSync(entry, `import { Session } from '${path.join(ROOT, 'js/session.js')}';\nimport { panelToolbox, PANEL_API } from '${path.join(ROOT, 'connector/view/tools.js')}';\nexport { Session, panelToolbox, PANEL_API };\n`);
  const fp = await loadFolded(entry, 'export const { Session, panelToolbox, PANEL_API } = __ENTRY__;\n');
  const fs2 = new fp.Session({ welcomeMenu: false });
  fs2.switchMachine('dragon64', undefined, { menu: false });
  check('fold: the folded panel toolbox is the plain one (PANEL_API, every tool and schema)', fp.PANEL_API === panel.PANEL_API && fp.Session !== Session
    && J(fp.panelToolbox(fs2, {}).tools()) === J(build.panelTools()));
  let refused = null;
  try { fold(path.join(ROOT, 'connector/fold.js')); } catch (e) { refused = e.message; }
  check('fold: a form it does not know fails loudly (node: imports are not relative files)', refused !== null, refused);

  // ---------------- the panel's tools ----------------
  const host = { roms: () => [], png: () => new Uint8Array(0), program: () => new Uint8Array(0), now: () => 0, date: () => new Date(0), yield: () => new Promise(setImmediate),
    readMedia() { throw new T.McpToolError('no-media-root'); }, writeMedia() { throw new T.McpToolError('no-media-root'); } };
  const local = Object.fromEntries(T.createToolbox(host).tools().map((t) => [t.name, t]));
  const offered = build.panelTools();
  check('panel tools: no ROM store in the panel, so add_roms and remove_roms are not offered (the toolbox would only refuse them)',
    !offered.some((t) => t.name === 'add_roms' || t.name === 'remove_roms') && !!local.add_roms && !!local.remove_roms, offered.map((t) => t.name).join(','));
  check('panel tools: the local server\'s names, schemas and annotations; the file tools and close_machine left out',
    offered.every((t) => t.name === 'boot' || J(t) === J(t.name === 'load' ? { ...local.load, description: local.load.description.replace(/ For playing or watching a machine with the person, prefer the CLOADM side-panel connector.*$/, '') } : local[t.name])) && J(offered.map((t) => t.name)) === J(Object.keys(local).filter((k) => !panel.LEFT_OUT.includes(k)))
    && !/side-panel connector/.test(offered.find((t) => t.name === 'load').description) && /side-panel connector/.test(local.load.description)
    && panel.LEFT_OUT.every((k) => local[k]) && J(offered.find((t) => t.name === 'boot').inputSchema) === J(local.boot.inputSchema), offered.map((t) => t.name).join(','));
  const want = ['boot', 'switch_machine', 'type_text', 'press_keys', 'screen_text', 'screenshot', 'peek', 'find_bytes', 'disassemble', 'registers', 'step', 'run', 'run_frames', 'load', 'reset', 'power_cycle'];
  check('panel tools: everything the panel runs is offered', want.every((w) => offered.some((t) => t.name === w)) && offered.length <= 64, want.filter((w) => !offered.some((t) => t.name === w)).join(','));
  const s = new Session({ welcomeMenu: false });
  s.switchMachine('dragon64', undefined, { menu: false });
  const ptb = panel.panelToolbox(s, Object.assign({}, host, { program: (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f))) }));
  const b64 = (b) => Buffer.from(b).toString('base64');
  await ptb.call('load', { machine_id: 'm1', program: 'liza' }, { base64: b64 });
  await ptb.call('run_frames', { machine_id: 'm1', frames: 100 }, { base64: b64 });
  const st = await ptb.call('screen_text', { machine_id: 'm1' }, { base64: b64 });
  check('panel tools: screen text comes back wrapped as untrusted machine_output, as from the local server', !st.isError && st.structuredContent.untrusted === T.UNTRUSTED_NOTE
    && /LIZA/.test(st.structuredContent.machine_output.lines.join('\n')) && JSON.parse(st.content[0].text).untrusted === T.UNTRUSTED_NOTE, J(st).slice(0, 300));
  const path1 = await ptb.call('load', { machine_id: 'm1', path: 'game.bin' }, { base64: b64 });
  const tape = await ptb.call('insert_tape', { machine_id: 'm1', path: 'x.cas' }, { base64: b64 });
  check('panel tools: a file is refused with no-media-root, naming what works; a left-out tool says why', path1.isError && path1.structuredContent.error.code === 'no-media-root'
    && /side panel has no media folder/.test(path1.structuredContent.error.detail) && tape.isError && /no tool "insert_tape" in the side panel/.test(tape.structuredContent.error.detail), J([path1, tape]).slice(0, 400));
  const fake = (k) => Uint8Array.from({ length: 16384 }, (_, i) => (i * 13 + k) & 255);
  const before = await ptb.call('peek', { machine_id: 'm1', address: 0x3000, length: 2 }, { base64: b64 });
  s.addRoms([{ name: 'd64_1.rom', bytes: fake(1) }, { name: 'd64_2.rom', bytes: fake(2) }]);
  const romReads = await Promise.all([ptb.call('peek', { machine_id: 'm1', address: 0x8000, length: 16 }, { base64: b64 }), ptb.call('find_bytes', { machine_id: 'm1', pattern: '01 0E' }, { base64: b64 }), ptb.call('disassemble', { machine_id: 'm1', address: 0x8000 }, { base64: b64 })]);
  check('panel tools: memory reads work without ROMs, and are refused once the user\'s ROMs are in (no tool returns ROM memory directly)', !before.isError && s.romCodeIn() === 'roms'
    && romReads.every((r) => r.isError && r.structuredContent.error.code === 'rejected' && /no tool returns ROM memory directly/.test(r.structuredContent.error.detail)), J(romReads).slice(0, 300));
  await ptb.call('boot', { roms: false }, { base64: b64 });
  await ptb.call('load', { machine_id: 'm1', program: 'liza' }, { base64: b64 });
  const bigText = { content: [{ type: 'text', text: 'x'.repeat(panel.TEXT_MAX + 1) }] }, okText = { content: [{ type: 'text', text: 'x'.repeat(panel.TEXT_MAX) }] };
  const bigImage = { content: [{ type: 'text', text: '{}' }, { type: 'image', data: 'A'.repeat(panel.TEXT_MAX), mimeType: 'image/png' }] };
  check('panel tools: a result over 100,000 characters (text and image data together) is refused with too-long; one at the limit passes', panel.TEXT_MAX === 100000
    && panel.capped(bigText).structuredContent.error.code === 'too-long' && panel.capped(okText) === okText && panel.capped(bigImage).isError);
  const shot = await ptb.call('screenshot', { machine_id: 'm1', scale: 3 }, { base64: b64 });
  check('panel tools: the picture is awaited (the browser encodes it) and sent as an image block', !shot.isError && shot.content[1].type === 'image', J(shot).slice(0, 200));
  check('panel tools: run_frames is capped as on the local server', offered.find((t) => t.name === 'run_frames').inputSchema.properties.frames.maximum === T.RUN_FRAMES_MAX && T.WALL_MS <= 25000);
  // every bundled program file a model can ask for, on every model, is carried (B inline, A fetched)
  const needed = new Set(['demo.bin', ...Object.values(GAMES.list).map((g) => g.file)]);
  for (const id of Object.keys(profiles)) {
    const ss = new Session({ welcomeMenu: false });
    ss.switchMachine(id, undefined, { menu: false });
    for (const f of [ss.welcomeFile, ss.lizaFile]) if (f) needed.add(f);
  }
  check('panel tools: PROGRAM_FILES is every welcome, LIZA, demo and game file a model can need', J([...needed].sort()) === J([...panel.PROGRAM_FILES].sort()), J([...needed].sort()));

  // ---------------- the bridge, in a vm, playing the host ----------------
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'connector/view/bridge.js'), 'utf8');
  function bridge(cfg = { api: panel.PANEL_API, tools: [{ name: 'screen_text' }], version: 'v' }) {
    const sent = [], handlers = [];
    const parent = { postMessage: (m) => sent.push(JSON.parse(J(m))) };
    const win = { CLOADM_VIEW: cfg, parent };
    const ctx = vm.createContext({ window: win, addEventListener: (t, fn) => { if (t === 'message') handlers.push(fn); }, setTimeout, clearTimeout, AbortController, Date, performance, Promise, JSON, String, Array, Object, Map });
    win.window = win;
    vm.runInContext(bridgeSrc, ctx);
    const deliver = (data) => handlers.forEach((fn) => fn({ source: parent, data }));
    const reply = (method, result) => { const m = sent.find((x) => x.method === method); deliver({ jsonrpc: '2.0', id: m.id, result }); };
    return { sent, deliver, reply, B: win.CLOADM_BRIDGE };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await tick(); return fn(); };
  {
    const b = bridge();
    const first = b.sent.slice();
    check('bridge: ui/initialize is sent as the script runs, before any emulator (listChanged: true)', first.length === 1 && first[0].method === 'ui/initialize' && first[0].params.appCapabilities.tools.listChanged === true, J(first));
    b.reply('ui/initialize', { hostInfo: { name: 'stub' } });
    await tick();
    check('bridge: then ui/notifications/initialized', b.sent.some((m) => m.method === 'ui/notifications/initialized'));
    b.deliver({ jsonrpc: '2.0', id: 50, method: 'tools/list' });
    check('bridge: tools/list is answered at once, from the build\'s list', J(b.sent.find((m) => m.id === 50).result.tools) === J([{ name: 'screen_text' }]));
    b.deliver({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'screen_text', arguments: { machine_id: 'm1' } } });
    await tick();
    check('bridge: a call before the emulator is ready waits (no reply yet), and no list_changed yet', !b.sent.some((m) => m.id === 51) && !b.sent.some((m) => m.method === 'notifications/tools/list_changed'));
    const got = [];
    b.B.attach({ api: panel.PANEL_API, tools: [{ name: 'screen_text' }, { name: 'peek' }], call: async (name, args) => { got.push([name, args]); return { content: [{ type: 'text', text: 'done' }] }; } });
    await waitFor(() => b.sent.some((m) => m.id === 51));
    check('bridge: attach sends notifications/tools/list_changed and serves the early call', b.sent.some((m) => m.method === 'notifications/tools/list_changed')
      && b.sent.find((m) => m.id === 51).result.content[0].text === 'done' && J(got) === J([['screen_text', { machine_id: 'm1' }]]));
    b.deliver({ jsonrpc: '2.0', id: 52, method: 'tools/list' });
    check('bridge: tools/list then gives the emulator\'s own list', J(b.sent.find((m) => m.id === 52).result.tools.map((t) => t.name)) === J(['screen_text', 'peek']));
    b.deliver({ jsonrpc: '2.0', id: 53, method: 'tools/call', params: { name: 'nope' } });
    b.deliver({ jsonrpc: '2.0', id: 54, method: 'ping' });
    check('bridge: an unknown tool is -32602; ping answers', b.sent.find((m) => m.id === 53).error.code === -32602 && J(b.sent.find((m) => m.id === 54).result) === '{}');
  }
  {
    const b = bridge();
    b.B.attach({ api: panel.PANEL_API, tools: [{ name: 'screen_text' }], call: async () => ({ content: [] }) });
    check('bridge: an emulator ready before the handshake: list_changed waits for initialized', !b.sent.some((m) => m.method === 'notifications/tools/list_changed'));
    b.reply('ui/initialize', {});
    await tick();
    check('bridge: ... and is sent once it is', b.sent.filter((m) => m.method === 'notifications/tools/list_changed').length === 1);
  }
  {
    const b = bridge();
    b.reply('ui/initialize', {});
    b.B.attach({ api: panel.PANEL_API + 1, tools: [{ name: 'screen_text' }], call: async () => ({ content: [{ type: 'text', text: 'served anyway' }] }) });
    b.deliver({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'screen_text', arguments: {} } });
    await waitFor(() => b.sent.some((m) => m.id === 60));
    const r = b.sent.find((m) => m.id === 60);
    const code = r?.result?.structuredContent?.error?.code ?? null;
    check('bridge: an emulator with another PANEL_API is refused: the call answers out-of-step', code === 'out-of-step', `got ${J(r)}`);
    check('bridge: ... and no list_changed is sent, and the status line says out-of-step', !b.sent.some((m) => m.method === 'notifications/tools/list_changed') && /out-of-step/.test(b.B.describe()), J(b.sent));
  }
  {
    const b = bridge();
    b.reply('ui/initialize', {});
    b.deliver({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'screen_text', arguments: {} } });
    b.B.fail('blocked by CORS policy');
    await waitFor(() => b.sent.some((m) => m.id === 70));
    const r = b.sent.find((m) => m.id === 70);
    check('bridge: a failed start answers waiting calls at once with not-started and the reason', r && r.result.structuredContent.error.code === 'not-started' && /CORS/.test(r.result.structuredContent.error.detail), J(r));
  }
  {
    const b = bridge();
    b.reply('ui/initialize', {});
    let release;
    b.B.attach({ api: panel.PANEL_API, tools: [{ name: 'run_frames' }], call: (n, a, { signal }) => new Promise((r) => { release = () => r({ content: [], aborted: signal.aborted }); }) });
    b.deliver({ jsonrpc: '2.0', id: 80, method: 'tools/call', params: { name: 'run_frames', arguments: {} } });
    await waitFor(() => release);
    b.deliver({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 80 } });
    release();
    await tick(); await tick();
    check('bridge: a cancelled call gets no reply', !b.sent.some((m) => m.id === 80));
  }

  {
    const b = bridge();
    b.reply('ui/initialize', { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], theme: 'dark' } });
    await tick();
    const seen = [];
    b.B.onChange(() => seen.push(b.B.hostContext.displayMode));
    const initial = Object.assign({}, b.B.hostContext);
    b.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } });
    check('bridge: hostContext starts as ui/initialize\'s and takes each host-context-changed in (the side-panel button reads displayMode)',
      initial.displayMode === 'inline' && b.B.hostContext.displayMode === 'fullscreen' && b.B.hostContext.theme === 'dark' && J(seen) === J(['fullscreen']), J([initial, b.B.hostContext, seen]));
    const asked = b.B.requestDisplayMode('inline');
    const req = b.sent.find((m) => m.method === 'ui/request-display-mode');
    b.deliver({ jsonrpc: '2.0', id: req.id, result: { mode: 'inline' } });
    await asked;
    check('bridge: the mode the host answers a request with is the context\'s at once', J(req.params) === J({ mode: 'inline' }) && b.B.hostContext.displayMode === 'inline', J(b.B.hostContext));
    b.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'pip', styles: { variables: { x: 1 } }, toString: 'x', __proto__: { polluted: 1 } } });
    b.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: 'not an object' });
    check('bridge: only the context keys the view reads are taken in (displayMode, availableDisplayModes, containerDimensions, theme)',
      J(Object.keys(b.B.hostContext).sort()) === J(['availableDisplayModes', 'displayMode', 'theme']) && b.B.hostContext.displayMode === 'pip' && !('polluted' in b.B.hostContext), J(b.B.hostContext));
  }

  // ---------------- the view's controls (connector/view/ui.js), the parts without a DOM ----------------
  {
    const ui = await imp('connector/view/ui.js');
    const sizes = [[376, 600], [576, 700], [876, 2000], [876, 400], [100, 2000], [376, null], [876, null]].map(([w, h]) => [w, h, ui.screenSize(w, h)]);
    const fits = sizes.every(([w, h, s]) => s.width <= w && (h == null || s.height <= h) && Math.abs(s.width / s.height - 4 / 3) < 0.01
      && (w - s.width < 2 || (h != null && h - s.height < 1)));
    check('screen: the largest 4:3 picture that fits, to the pixel, in the limiting dimension; with no height given (inline), the full width', fits
      && J(ui.screenSize(376, null)) === J({ width: 376, height: 282 }) && J(ui.screenSize(876, 400)) === J({ width: 533, height: 400 }), J(sizes));
    check('screen: the height is fixed in the side panel and fullscreen, or when the host gives one; inline it follows the content',
      ui.fixedHeight({ displayMode: 'fullscreen' }) && ui.fixedHeight({ displayMode: 'pip' }) && ui.fixedHeight({ displayMode: 'inline', containerDimensions: { height: 500 } })
      && !ui.fixedHeight({ displayMode: 'inline' }) && !ui.fixedHeight({ displayMode: 'inline', containerDimensions: { maxHeight: 900 } }) && !ui.fixedHeight({}));
    const names = { model: (id) => ({ coco3: 'CoCo 3' })[id], program: (id) => ({ liza: 'LIZA' })[id] };
    const typing = ui.describeCall('type_text', { text: 'DIR\n' }), keys = ui.describeCall('press_keys', { keys: ['SHIFT', 'A'] });
    const load = ui.describeCall('load', { program: 'liza' }, names), sw = ui.describeCall('switch_machine', { model: 'coco3' }, names), reset = ui.describeCall('reset');
    check('chip: typing says "Claude is typing: " and the keys (Enter as ↵), then "Claude typed "; a load, a switch and a reset say what they did',
      typing.now === 'Claude is typing: ' && typing.past === 'Claude typed ' && typing.keys === 'DIR↵' && !typing.read && keys.keys === 'SHIFT + A'
      && load.past === 'Claude loaded LIZA' && !load.keys && sw.past === 'Claude switched to the CoCo 3' && reset.past === 'Claude reset the machine', J([typing, keys, load, sw, reset]));
    const reads = ['screen_text', 'screenshot', 'peek', 'find_bytes'].map((n) => ui.describeCall(n, {}, { read: true }));
    check('chip: a reading call is a quiet "Claude read the screen" or "Claude read memory"', reads.every((r) => r.read && !r.keys)
      && J(reads.map((r) => r.now)) === J(['Claude read the screen', 'Claude read the screen', 'Claude read memory', 'Claude read memory']), J(reads));
    const say = (keys, read = false) => ui.announcement(Object.assign(ui.describeCall(read ? 'screen_text' : 'type_text', { text: keys }, { read })));
    const short = say('DIR\n'), mid = say('A'.repeat(100)), long = say('B'.repeat(2000));
    check('announcement: short keys whole, more than 40 cut at 40 with an ellipsis, a long text by its length; none for a read',
      short === 'Claude is typing: DIR↵' && mid === `Claude is typing: ${'A'.repeat(40)}…` && long === 'Claude is typing 2,000 characters' && say('', true) === null, J([short, mid, long]));
    const unnamed = offered.filter((t) => !t.annotations.readOnlyHint).filter((t) => /^Claude: /.test(ui.describeCall(t.name, {}, { title: t.title }).now)).map((t) => t.name);
    check('chip: every panel tool that acts (readOnlyHint false) has its own words', !unnamed.length, unnamed.join(','));
  }

  // ---------------- the PANEL_API contract ----------------
  // What the view's HTML (built into the Worker) and the emulator module (served by cloadm.dev) expect of each other:
  // the bridge's members and what attach() reads, the CLOADM_VIEW fields and who reads them, the shell's element ids.
  // Its hash is recorded with the PANEL_API it belongs to: change the contract and this fails until PANEL_API is raised
  // (connector/view/tools.js) and the new pair recorded here.
  const CONTRACT = { api: 2, sha256: '1a39f12bd1d4bf70f938d2651f72cdb2e6514b09b64ea01a7a32ebd5dcee754a' };
  {
    const b = bridge();
    const uniq = (re, text) => [...new Set([...text.matchAll(re)].map((m) => m[1]))].sort();
    const panelSrc = fs.readFileSync(path.join(ROOT, 'connector/view/panel.js'), 'utf8');
    const shellIds = uniq(/\bid="([^"]+)"/g, views.site.replace(/<script[\s\S]*?<\/script>/g, ''));
    const contract = {
      bridgeMembers: Object.getOwnPropertyNames(b.B).sort(),
      arity: { attach: b.B.attach.length, fail: b.B.fail.length, onChange: b.B.onChange.length, requestDisplayMode: b.B.requestDisplayMode.length },
      attachReads: uniq(/\b(?:x|impl)\.(\w+)/g, bridgeSrc),
      viewFields: [...new Set([...Object.keys(cfgA), ...Object.keys(cfgB)])].sort(),
      cfgReads: uniq(/\bcfg\.(\w+)/g, bridgeSrc + panelSrc),
      panelUsesBridge: uniq(/\bbridge\.(\w+)/g, panelSrc),
      panelIds: uniq(/\$\('([\w-]+)'\)/g, panelSrc),
      shellIds,
    };
    const sha = require('crypto').createHash('sha256').update(J(contract)).digest('hex');
    const missingIds = contract.panelIds.filter((id) => !shellIds.includes(id));
    check('PANEL_API contract: every element panel.js uses is in the shell', !missingIds.length, missingIds.join(','));
    const api = panel.PANEL_API;
    check(`PANEL_API contract: the recorded hash is this contract's, under PANEL_API ${api}`, sha === CONTRACT.sha256 && api === CONTRACT.api,
      sha === CONTRACT.sha256 ? `PANEL_API is ${api} but the contract was recorded under ${CONTRACT.api}: record { api: ${api}, sha256: '${sha}' }`
        : api === CONTRACT.api ? `the contract changed (${sha}) but PANEL_API is still ${api}: raise PANEL_API in connector/view/tools.js, then record the new pair ${J(contract)}`
          : `PANEL_API is now ${api}: record { api: ${api}, sha256: '${sha}' }`);
  }

  // ---------------- what the docs claim about ROMs ----------------
  // ROM memory is not sealed: a program run on the machine can read it (tests/mcp.test.js pins that). Nothing may claim
  // that no ROM byte leaves the panel; the guide must say what is true instead.
  const claimFiles = ['docs/mcp.md', 'CHANGELOG.md', 'README.md', 'skills/cloadm/SKILL.md', ...['view/tools.js', 'view/panel.js', 'view/bridge.js', 'worker/src/server.js', 'build.js'].map((f) => `connector/${f}`), 'js/mcp/tools.js'];
  const overclaims = claimFiles.filter((f) => /no ROM bytes? (ever )?leaves?|never leaves? (this host|the panel)|ROMs? (never|cannot) leave/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('no file claims that no ROM byte leaves the panel; the guide says a determined agent can infer ROM contents through execution', !overclaims.length
    && /a\s+determined agent can infer ROM contents through execution/.test(fs.readFileSync(path.join(ROOT, 'docs/mcp.md'), 'utf8')), overclaims.join(', '));

  // the lead: "Use the connector" comes before any plugin heading, and the table has its 7 rows
  for (const f of ['README.md', 'docs/mcp.md']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lead = t.indexOf('**Use the connector.**'), plug = t.indexOf('**For developers and your own files: the plugin.**'), tab = t.indexOf('| You want to… | Use |');
    const rows = tab < 0 ? [] : t.slice(tab).split('\n').slice(2).filter((l) => /^\|/.test(l)).slice(0, 7);
    const firstPlugin = t.search(/^#{1,3} .*[Pp]lugin/m);
    check(`${f}: "Use the connector" leads, before the plugin and before any plugin heading; the Which-one table has 7 rows`,
      lead >= 0 && plug > lead && tab > plug && (firstPlugin < 0 || firstPlugin > lead) && rows.length === 7 && /\| \.mcpb extension \|$/.test(rows[6]) && /not yet tested on phones/.test(rows[1]), `${lead} ${plug} ${tab} ${rows.length}`);
    const zips = [...new Set([...t.matchAll(/`([\w.-]+\.zip)`/g)].map((m) => m[1]))], rel = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    check(`${f}: names the skill zip, and release.yml publishes that exact file`, zips.length === 1 && rel.includes(`dist/${zips[0]}`), zips.join(','));
    check(`${f}: says web and the desktop app, and that phones are not yet tested`, /side panel on the web and in the desktop app \(phones not yet tested\)/.test(t));
  }
  console.log(`${n - fail}/${n} connector checks passed`);
  process.exitCode = fail ? 1 : 0;
// (straight to stdout: a failure while the Worker is probed comes while console is stubbed)
})().catch((e) => { process.stdout.write(`FAIL ${String(e.stack).slice(0, 2000)}\n`); process.exitCode = 1; });
